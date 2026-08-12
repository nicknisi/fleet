// State-refresh orchestration: the three-layer state engine (hook signals,
// JSONL events, pane scraping) fused into AgentState[], plus the slow/fast
// cache lifecycle, the control-mode TUI seam, and the write-path helpers
// (scrape verification + acknowledgement). Extracted verbatim from index.ts —
// pure code movement, no behavior change: index.ts (TUI loop) and
// src/cli/router.ts (CLI dispatch) both drive these functions.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fuseState, hookStateForStatus } from './engine.ts';
import { readAllStatusDirs, statusFilePath, eventsFilePath, writeFileAtomic } from './hooks.ts';
import { readLastEvents, deriveStatusFromEvents } from './events.ts';
import { acknowledgePlan } from './acknowledge.ts';
import {
  detectFromPaneContent,
  detectFromTitle,
  scrapePane,
  capturePaneLines,
  capturePaneLinesVia,
} from './scraper.ts';
import { loadDetectionManifest } from './detection.ts';
import { loadRenames } from './rename.ts';
import {
  AgentStatus,
  extractClaudeName,
  type AgentState,
  type ResolvedHookStatus,
  type StateDecision,
} from './types.ts';
import type { AgentDir } from '../agents/config.ts';
import {
  parsePsTable,
  pruneDoneTracking,
  readPsTable,
  resolveDiscoveredStatus,
  scanDiscovered,
  type DiscoveredAgent,
  type DoneTracking,
} from '../agents/discovery.ts';
import { listPanesResult, type ListPanesResult, type PaneInfo } from '../tmux/sessions.ts';
import { readGitMetadata, branchLabel, type GitMetadata } from './git-metadata.ts';
import type { TmuxControlClient } from '../tmux/control.ts';
import { listPanesResultVia } from '../tmux/control-adapter.ts';
import { flipControlDead, type ControlLatch } from '../tmux/control-router.ts';
import { tmuxOrNull } from '../tmux/ipc.ts';
import { detectPorts } from '../tmux/ports.ts';

export function shortenPath(path: string): string {
  const home = Bun.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

export function discoveredDecision(
  status: AgentStatus,
  workingGlyph: boolean,
  scrapeStatus: AgentStatus | null,
  scrapeRuleId: string | null,
  now: number,
): StateDecision {
  const scrapeWon = scrapeStatus !== null && scrapeStatus === status;
  const reason =
    status === AgentStatus.DONE
      ? 'discovered agent transitioned from working to idle while unfocused'
      : scrapeWon
        ? 'discovered from a live pane or title rule'
        : workingGlyph
          ? 'discovered process showed a live working glyph'
          : 'discovered process had no active prompt or working signal';
  return {
    final: status,
    // The process-scan glyph has no hook/event/scrape slot. Keep actual scrape
    // evidence honest and use winner=default + an explicit reason when the
    // glyph, rather than a rule, determined BUSY.
    candidates: { hook: null, event: null, scrape: scrapeStatus },
    hookTs: 0,
    eventTs: null,
    now,
    winner: scrapeWon ? 'scrape' : 'default',
    reason,
    workingTimeoutFired: false,
    scrapeRuleId,
  };
}

// Slow caches (git metadata, ports, scrape) — refreshed every SLOW_REFRESH_MS.
// Keyed by unique pane cwd: a read-only GitMetadata snapshot (repository
// identity, worktree root, branch/detached, dirty counts, ahead/behind,
// diffstat) or null on a non-git dir. Replaces the old branch-only cache.
const gitMetadataCache = new Map<string, GitMetadata | null>();
const GIT_METADATA_REFRESH_MS = 10_000;
let gitMetadataUpdatedAt = 0;
let portCache = new Map<string, number[]>();
const scrapeCache = new Map<string, AgentStatus | null>();
// Parallel to scrapeCache: the matched scraper rule id for each pane's cached
// scrape (null when nothing matched). Kept beside the status so the
// observability API can report why the cached scrape slot read what it did,
// without changing the fusion's status output.
const scrapeRuleCache = new Map<string, string | null>();
// When the scrape cache was last rebuilt (epoch seconds). A hook/event write
// newer than this means the screen has changed since the snapshot — the cached
// read is stale and must not mask the fresher signal.
let scrapeCacheTs = 0;
// Hook-less discovery (Phase 3): paneId -> synthetic agent, rebuilt on the slow
// tick and read on every fast tick — same lifecycle as scrapeCache/portCache.
// discoveryLastWorking carries the spinner-debounce timestamps across slow ticks
// (pruned inside discoverAgents to only currently-discovered panes).
let discoveryCache = new Map<string, DiscoveredAgent>();
let discoveryLastWorking = new Map<string, number>();
// Working→idle transition memory for discovered agents ("finished while you
// were elsewhere" DONE). Mutated by resolveDiscoveredStatus on every fast tick,
// pruned to live discovered panes on the slow tick. In-memory only, so one-shot
// CLI runs (fleet status) never synthesize DONE — the TUI and fleet wait do.
const discoveryDone: DoneTracking = { wasBusy: new Set(), done: new Set() };
let lastTmuxOk = true;

// The result of the most recent list-panes across any refresh path. index.ts's
// TUI loop reads it to drive the "tmux is down" banner. A getter (not the raw
// binding) so the mutable module state stays encapsulated here.
export function getLastTmuxOk(): boolean {
  return lastTmuxOk;
}

// User renames (session name → custom label), loaded once per entry point and
// re-read after each rename. A display overlay only — grouping/selection still
// key off the real session name.
let renameCache = new Map<string, string>();
export function reloadRenameCache(): void {
  renameCache = loadRenames();
}

// A scraped correction persisted back to the winning hook's status file: when a
// pane's live screen disagrees with its stored hook state (a prompt was
// answered, a turn finished), write the scraped truth so the next read agrees.
export function verifyPaneState(state: AgentState, statusDirs: string[]): void {
  const scraped = scrapePane(state.paneId, state.agentType || 'claude');
  if (scraped === null) return;
  if (scraped === state.status) return;

  const now = Math.floor(Date.now() / 1000);
  const tmuxPid = parseInt(tmuxOrNull(['display-message', '-p', '#{pid}']) ?? '', 10) || 0;
  const newHookState = hookStateForStatus(scraped);

  for (const dir of statusDirs) {
    const file = statusFilePath(dir, state.paneId);
    try {
      const content = readFileSync(file, 'utf-8');
      const existing = JSON.parse(content);
      if (existing.pane === state.paneId) {
        // A scraped idle screen (bare prompt, no dialog/spinner) can't be told
        // apart from a just-finished turn — both show a prompt. So never let it
        // overwrite a done/working hook state; only use it to clear a stale
        // prompt (permit/question/waiting) that's actually gone from the screen.
        if (scraped === AgentStatus.IDLE && !['permit', 'question', 'waiting'].includes(existing.state)) {
          return;
        }
        const updated = JSON.stringify({
          ...existing, // preserve tool (enriched label) + any custom field
          state: newHookState,
          pane: state.paneId,
          session: state.session,
          ts: now,
          tmux_pid: tmuxPid,
        });
        writeFileAtomic(file, updated + '\n');
        scrapeCache.set(state.paneId, scraped);
        // scrapePane discards the rule id, so the correction path can't attribute
        // a rule — clear any stale one so the cache stays consistent.
        scrapeRuleCache.set(state.paneId, null);
        return;
      }
    } catch {}
  }
}

// Acknowledging a ready agent marks it seen — you've looked, so it drops out of
// the attention tier. A ready agent's DONE has two independent sources, so
// acknowledgePlan decides both actions: flip a ready status file to idle, and
// append an Acknowledged event when the event stream derives DONE (the common
// case — the bar shows DONE from a Stop event while the status file lags at
// idle). Either signal alone is enough to clear the agent. Self-gating: a
// working/waiting/asking agent derives neither, so it's left untouched.
export function acknowledgePane(paneId: string, statusDirs: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  for (const dir of statusDirs) {
    const statusFile = statusFilePath(dir, paneId);
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(statusFile, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (current.pane !== paneId) continue;

    const eventsFile = eventsFilePath(dir, paneId);
    const recent = existsSync(eventsFile) ? readLastEvents(eventsFile, 12) : [];
    const plan = acknowledgePlan(current, recent, now);

    if (plan.status) {
      try {
        writeFileAtomic(statusFile, JSON.stringify(plan.status) + '\n');
      } catch {
        // Best effort — acknowledgement is non-critical
      }
    }
    if (plan.appendAck && existsSync(eventsFile)) {
      try {
        appendFileSync(eventsFile, JSON.stringify({ event: 'Acknowledged', ts: now }) + '\n');
      } catch {
        // Best effort
      }
    }
    return;
  }
}

// Acknowledge every ready agent across all tracked panes in one sweep — backs
// the status-line "clear all" chip. Reuses acknowledgePane's ready-only gating,
// so working/waiting/asking agents are left untouched.
export function acknowledgeAllReady(dirs: AgentDir[]): void {
  const statusDirs = dirs.map((d) => d.statusDir);
  for (const hook of readAllStatusDirs(dirs)) {
    acknowledgePane(hook.pane, statusDirs);
  }
}

export function refreshSlowCaches(panes: PaneInfo[], hookStatuses: ResolvedHookStatus[]): void {
  refreshSlowCachesWithCapture(panes, hookStatuses, capturePaneLines);
}

// Same scan as refreshSlowCaches, but the per-pane capture is supplied by the
// caller. The fork path passes capturePaneLines (sync); the control-mode TUI
// path pre-fetches every pane via the control client, then passes a sync
// lookup into the cache so the rest of the slow-tick work (git, ports,
// discovery, classification) runs unchanged and shared between both paths.
export function refreshSlowCachesWithCapture(
  panes: PaneInfo[],
  hookStatuses: ResolvedHookStatus[],
  captureFn: (paneId: string) => string[],
): void {
  const paths = new Set<string>();
  for (const p of panes) paths.add(p.currentPath);
  const nowMs = Date.now();
  if (
    nowMs - gitMetadataUpdatedAt >= GIT_METADATA_REFRESH_MS ||
    paths.size !== gitMetadataCache.size ||
    [...paths].some((path) => !gitMetadataCache.has(path))
  ) {
    gitMetadataCache.clear();
    for (const path of paths) gitMetadataCache.set(path, readGitMetadata(path));
    gitMetadataUpdatedAt = nowMs;
  }

  // One pane_pid map (from the caller's list-panes) and one ps pass, shared by
  // port detection and hook-less discovery — no extra tmux/ps spawns.
  const panePids = new Map<number, string>();
  for (const p of panes) {
    if (!Number.isNaN(p.panePid)) panePids.set(p.panePid, p.paneId);
  }
  const psTable = readPsTable();
  const { ppidByPid } = parsePsTable(psTable);

  const newPorts = new Map<string, number[]>();
  try {
    for (const pp of detectPorts(panePids, ppidByPid)) {
      const existing = newPorts.get(pp.paneId) ?? [];
      existing.push(pp.port);
      newPorts.set(pp.paneId, existing);
    }
  } catch {}
  portCache = newPorts;

  // Which agent owns each pane, so the scraper picks that agent's detection
  // manifest. Freshness-wins on a pane-id collision across dirs — same rule as
  // refreshStates' hookByPane.
  const paneAgent = new Map<string, { agent: string; ts: number }>();
  for (const h of hookStatuses) {
    const prev = paneAgent.get(h.pane);
    if (!prev || h.ts > prev.ts) paneAgent.set(h.pane, { agent: h.agent, ts: h.ts });
  }

  // Layer 3: pane scraping (~50ms per pane) — slow cycle only. Capture each
  // pane ONCE, without classifying yet: classification needs the pane's agent
  // identity, and hook-less panes are only named by discovery below.
  const captureCache = new Map<string, string[]>();
  for (const p of panes) {
    const lines = captureFn(p.paneId);
    if (lines.length > 0) captureCache.set(p.paneId, lines);
  }

  // Hook-less agent discovery: map allowlisted processes with no .status file to
  // their host pane and classify working from the spinner glyph, reusing the
  // captures + pane/ps tables above (zero extra subprocess spawns). A synthetic
  // agent here fills refreshStates' no-hook branch, so a hooked agent's status
  // always wins its pane and discovery never shadows it. Failure -> empty, and
  // the pane falls back to SHELL exactly as before Phase 3.
  try {
    const now = Math.floor(Date.now() / 1000);
    const discovered = scanDiscovered(captureCache, panePids, psTable, discoveryLastWorking, now);
    discoveryCache = new Map(discovered.agents.map((a) => [a.paneId, a]));
    discoveryLastWorking = discovered.lastWorking;
  } catch {
    discoveryCache = new Map();
  }

  // Every pane's agent identity is now known (winning hook first, discovery
  // second, claude as the fallback) — classify each capture exactly once
  // against the right manifest.
  const seen = new Set<string>();
  for (const p of panes) {
    seen.add(p.paneId);
    const lines = captureCache.get(p.paneId);
    if (!lines) {
      scrapeCache.set(p.paneId, null);
      scrapeRuleCache.set(p.paneId, null);
      continue;
    }
    const agent = paneAgent.get(p.paneId)?.agent ?? discoveryCache.get(p.paneId)?.agentType ?? 'claude';
    const detected = detectFromPaneContent(lines, loadDetectionManifest(agent));
    scrapeCache.set(p.paneId, detected.status);
    scrapeRuleCache.set(p.paneId, detected.ruleId);
  }
  for (const paneId of scrapeCache.keys()) {
    if (!seen.has(paneId)) {
      scrapeCache.delete(paneId);
      scrapeRuleCache.delete(paneId);
    }
  }
  scrapeCacheTs = Math.floor(Date.now() / 1000);

  pruneDoneTracking(discoveryDone, new Set(discoveryCache.keys()));
}

// Fast refresh: ONE tmux call + status file reads + last-line JSONL reads. No
// git, no lsof. The full (slow) path threads its own pane list + hook statuses
// through `pre` so they're read once per tick, not once per phase.
export function refreshStates(
  dirs: AgentDir[],
  pre?: { panesResult: ListPanesResult; hookStatuses: ResolvedHookStatus[] },
): AgentState[] {
  const hookStatuses = pre?.hookStatuses ?? readAllStatusDirs(dirs);
  const { ok: tmuxOk, panes } = pre?.panesResult ?? listPanesResult();
  lastTmuxOk = tmuxOk;

  // tmux pane ids (%N) are server-global, so the same pane number can have a
  // .status in two agents' dirs while only one agent truly occupies it. Keep the
  // freshest record per pane; its `agent`/`statusDir` then drive agentType and
  // the events read below.
  const hookByPane = new Map<string, (typeof hookStatuses)[number]>();
  for (const h of hookStatuses) {
    const prev = hookByPane.get(h.pane);
    if (!prev || h.ts > prev.ts) hookByPane.set(h.pane, h);
  }

  const states: AgentState[] = [];

  for (const pane of panes) {
    const hook = hookByPane.get(pane.paneId);

    let status: AgentStatus;
    let tool: string | null = null;
    let ts = Math.floor(Date.now() / 1000);
    let agentType = ''; // shell pane: honestly no agent (cards.ts filters it out)
    let tracking: 'hook' | 'discovery' | 'shell' = 'shell';
    let decision: StateDecision | undefined;

    if (hook) {
      // Read events from the WINNING hook's own dir (not a first-match scan
      // across all dirs, which could read the wrong agent's stream on collision).
      const eventsFile = eventsFilePath(hook.statusDir, pane.paneId);
      const recent = readLastEvents(eventsFile, 12);
      const eventStatus = recent.length > 0 ? deriveStatusFromEvents(recent) : null;
      const eventTs = recent.at(-1)?.ts ?? null;

      tool = hook.tool || null;
      ts = hook.ts;
      agentType = hook.agent;
      tracking = 'hook';

      // The pane title is re-read every fast tick, so a title-rule match (codex's
      // "Action Required", a braille working spinner) is both fresher and cheaper
      // than the ~5s-stale scrape cache — when it fires, it takes the scrape slot
      // in the fusion; the screen scrape covers the ticks where the title is
      // silent. The rule id rides along so the observability API can report why
      // the scrape slot read what it did.
      const titleResult = detectFromTitle(pane.paneTitle, loadDetectionManifest(hook.agent));
      const titleStatus = titleResult.status;

      // The cached scrape is a snapshot from the last slow tick. A hook/event
      // write since then means the screen has changed (a prompt was answered, a
      // turn ended) — drop the snapshot rather than let a stale PERMIT/QUESTION
      // mask the fresher signal until the next slow tick.
      const scrapeFresh = Math.max(hook.ts, eventTs ?? 0) <= scrapeCacheTs;
      const cachedScrape = scrapeFresh ? (scrapeCache.get(pane.paneId) ?? null) : null;

      const fused = fuseState({
        hookState: hook.state,
        hookTs: hook.ts,
        eventStatus,
        eventTs,
        scrapeStatus: titleStatus ?? cachedScrape,
        // The title's rule id wins when it fired; otherwise attribute the cached
        // scrape's own rule id (retained in scrapeRuleCache) so a cached
        // PERMIT/QUESTION/BUSY read is traceable too. Only the status feeds the
        // fusion, so this doesn't change what state is decided.
        scrapeRuleId:
          titleStatus !== null ? titleResult.ruleId : scrapeFresh ? (scrapeRuleCache.get(pane.paneId) ?? null) : null,
      });
      status = fused.status;
      decision = fused.decision;
    } else {
      // No winning hook. Before falling to SHELL, check hook-less discovery: an
      // allowlisted process in this pane surfaces as a synthetic agent, fusing
      // the spinner glyph with its own manifest's screen scrape and title rules
      // (via the same engine fusion as the hook path) — so a discovered agent
      // can show PERMIT/QUESTION/DONE, not just BUSY/IDLE, even when no hook is
      // writing (e.g. the plugin's hooks were silently unloaded).
      const disc = discoveryCache.get(pane.paneId);
      if (disc) {
        const manifest = loadDetectionManifest(disc.agentType);
        const titleResult = detectFromTitle(pane.paneTitle, manifest);
        const cachedScrape = scrapeCache.get(pane.paneId) ?? null;
        const scrapeStatus = titleResult.status ?? cachedScrape;
        const scrapeRuleId =
          titleResult.status !== null ? titleResult.ruleId : (scrapeRuleCache.get(pane.paneId) ?? null);
        status = resolveDiscoveredStatus(
          pane.paneId,
          {
            glyphWorking: disc.working,
            scrape: cachedScrape,
            title: titleResult.status,
            focused: pane.focused,
          },
          discoveryDone,
          ts,
        );
        decision = discoveredDecision(status, disc.working, scrapeStatus, scrapeRuleId, ts);
        agentType = disc.agentType;
        tracking = 'discovery';
      } else {
        status = AgentStatus.SHELL;
      }
    }

    const git = gitMetadataCache.get(pane.currentPath) ?? null;

    states.push({
      paneId: pane.paneId,
      paneNum: pane.paneNum,
      session: pane.sessionName,
      window: pane.windowName,
      windowId: pane.windowId,
      claudeName: extractClaudeName(pane.paneTitle),
      customName: renameCache.get(pane.sessionName) ?? null,
      status,
      tool,
      project: shortenPath(pane.currentPath),
      branch: branchLabel(git),
      git,
      ports: portCache.get(pane.paneId) ?? [],
      ts,
      agentType,
      tracking,
      paneTitle: pane.paneTitle,
      decision,
    });
  }

  return states;
}

// Full refresh: one list-panes + one status-dir read feed both the slow caches
// and the fast refresh.
export function fullRefreshStates(dirs: AgentDir[]): AgentState[] {
  const panesResult = listPanesResult();
  const hookStatuses = readAllStatusDirs(dirs);
  refreshSlowCaches(panesResult.panes, hookStatuses);
  return refreshStates(dirs, { panesResult, hookStatuses });
}

// --- TUI control-mode refresh seam ---------------------------------------
// Async variants the TUI tick selects between. When the control client is
// live, list-panes + per-pane capture go through it (one long-lived child,
// zero forks); on ANY throw the latch flips, the client is closed, and the
// batch re-runs through the synchronous fork path. After a flip, the latch
// stays dead for the whole session — no retries. These are thin shells over
// the shared refreshStates / refreshSlowCachesWithCapture so pane data shapes
// are identical between paths. CLI one-shot paths never call these.
export async function refreshStatesTui(
  dirs: AgentDir[],
  client: TmuxControlClient | null,
  latch: ControlLatch,
): Promise<AgentState[]> {
  if (client === null || latch.dead) return refreshStates(dirs);
  try {
    const panesResult = await listPanesResultVia(client);
    const hookStatuses = readAllStatusDirs(dirs);
    return refreshStates(dirs, { panesResult, hookStatuses });
  } catch {
    flipControlDead(latch);
    try {
      await client.close();
    } catch {}
    return refreshStates(dirs);
  }
}

export async function fullRefreshStatesTui(
  dirs: AgentDir[],
  client: TmuxControlClient | null,
  latch: ControlLatch,
): Promise<AgentState[]> {
  if (client === null || latch.dead) return fullRefreshStates(dirs);
  try {
    // Resync barrier before the scan batch — drains any stale/unsolicited
    // blocks so the list-panes read pairs with its own response.
    await client.sync();
    const panesResult = await listPanesResultVia(client);
    const hookStatuses = readAllStatusDirs(dirs);
    // Pre-fetch every pane's capture via the control client, then hand the
    // cache to the shared slow-tick body so git/ports/discovery/classification
    // run identically to the fork path.
    const captureCache = new Map<string, string[]>();
    for (const p of panesResult.panes) {
      const lines = await capturePaneLinesVia(client, p.paneId);
      if (lines.length > 0) captureCache.set(p.paneId, lines);
    }
    refreshSlowCachesWithCapture(panesResult.panes, hookStatuses, (id) => captureCache.get(id) ?? []);
    return refreshStates(dirs, { panesResult, hookStatuses });
  } catch {
    flipControlDead(latch);
    try {
      await client.close();
    } catch {}
    return fullRefreshStates(dirs);
  }
}
