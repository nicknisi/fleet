// Hook-less agent discovery (Phase 3). Fleet has no hook integration for agents
// like aider, cursor, opencode or gemini-cli, so they never write a `.status`
// file and are invisible to the registry. This module surfaces them the
// harness-agnostic way agent-radar proves out: scan the process table for
// allowlisted command names, map each back to its host tmux pane by walking the
// ppid chain, and classify "working" from the animated braille spinner glyph the
// harness paints on-screen. The result is a synthetic agent per pane, folded into
// fleet's state engine at the ONE place a pane currently falls to SHELL — the
// no-winning-hook branch in refreshStates. Because discovery only fills that
// branch, dedup is automatic: a hooked agent's `.status` always wins its pane and
// discovery never shadows it.
//
// The file is split into a pure core (parse ps + walk ppid chains + classify the
// glyph → discovered agents) that takes fixture strings, and a thin I/O shell
// (spawn ps, call tmux, read config) the app wires up. All logic lives in the
// pure core so it is unit-testable without a live process table or tmux server.

import { WORKING_GLYPH_PATTERN } from '../state/detection.ts';
import { fuseDiscoveredState } from '../state/engine.ts';
import { AgentStatus } from '../state/types.ts';
import { getTmuxOption } from '../tmux/ipc.ts';

export interface DiscoveredAgent {
  paneId: string;
  agentType: string;
  working: boolean;
}

export interface DiscoveryOpts {
  allowlist: Set<string>; // command names counted as agents (normalized)
  idleSecs: number; // grace before working->stopped (debounce), default 3
  now: number; // epoch seconds
  lastWorking: Map<string, number>; // paneId -> last ts a glyph was seen (carried across ticks)
}

// Compiled once. WORKING_GLYPH_PATTERN is Phase 1's braille range (U+2800–U+28FF)
// — reused verbatim so discovery and the claude manifest rule can never drift.
const GLYPH = new RegExp(WORKING_GLYPH_PATTERN);

// Strip the login-shell dash and any directory path before allowlist matching:
// a login shell reports `-zsh`; a pathful comm reports `/usr/bin/aider` (macOS
// `ps -o comm` gives the executable's full path). Mirrors agent-radar's
// `agent_for_tty` normalization so `aider`, `-zsh`, `/usr/bin/aider` all reduce
// to their bare command name.
export function normalizeComm(comm: string): string {
  let c = comm.trim();
  if (c.startsWith('-')) c = c.slice(1); // login-shell marker
  const slash = c.lastIndexOf('/');
  if (slash >= 0) c = c.slice(slash + 1); // basename
  return c;
}

// Parse `ps -eo pid=,ppid=,comm=` lines into pid->comm and pid->ppid maps. The
// `=` suffixes suppress headers, so every non-blank line is a record: leading
// pad, right-aligned pid, ppid, then comm (which may itself contain spaces or a
// path, so it is the whole remainder of the line). comm is normalized at parse
// time so callers compare against bare command names.
export function parsePsTable(psTable: string[]): {
  commByPid: Map<number, string>;
  ppidByPid: Map<number, number>;
} {
  const commByPid = new Map<number, string>();
  const ppidByPid = new Map<number, number>();
  for (const line of psTable) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const ppid = parseInt(m[2]!, 10);
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    commByPid.set(pid, normalizeComm(m[3]!));
    ppidByPid.set(pid, ppid);
  }
  return { commByPid, ppidByPid };
}

// Walk a pid up its parent chain until a pid is a known pane_pid, returning that
// pane's id (or null if the chain reaches init/root without ever hitting a pane).
// Pure, in-memory version of ports.ts:findPaneForPid — no per-hop `ps` spawn
// because the whole table is already parsed. Visited-guarded against cycles
// exactly like ports.ts:56-57.
export function walkToPane(
  startPid: number,
  ppidByPid: Map<number, number>,
  panePids: Map<number, string>,
): string | null {
  let checkPid = startPid;
  const visited = new Set<number>();
  while (checkPid > 1 && !visited.has(checkPid)) {
    visited.add(checkPid);
    const paneId = panePids.get(checkPid);
    if (paneId) return paneId;
    const ppid = ppidByPid.get(checkPid);
    if (ppid === undefined || ppid <= 1) break;
    checkPid = ppid;
  }
  return null;
}

// The pure core. Given the process table, the pane_pid->paneId map, and per-pane
// captures (bottom-of-pane text), return the discovered agent per pane with a
// debounced working state, plus the pruned lastWorking map to carry to the next
// tick.
//
// 1. Parse ps -> commByPid, ppidByPid.
// 2. For each allowlisted pid, walk its ppid chain to a pane; first match per
//    pane wins (agentType = its normalized comm).
// 3. For each discovered pane, classify the glyph and debounce:
//    - glyph present -> working, and re-anchor lastWorking[pane] = now.
//    - glyph absent  -> working iff now - lastWorking[pane] < idleSecs (grace),
//      carrying the OLD lastWorking timestamp forward so the grace window stays
//      anchored to the last glyph actually seen (never refreshed while idle, or a
//      pane sampled faster than idleSecs would never expire).
// 4. Return agents + lastWorking pruned to currently-discovered panes.
export function discoverAgents(
  psTable: string[],
  panePids: Map<number, string>,
  captures: Map<string, string>,
  opts: DiscoveryOpts,
): { agents: DiscoveredAgent[]; lastWorking: Map<string, number> } {
  const agents: DiscoveredAgent[] = [];
  const nextLastWorking = new Map<string, number>();

  if (opts.allowlist.size === 0 || panePids.size === 0) {
    return { agents, lastWorking: nextLastWorking };
  }

  const { commByPid, ppidByPid } = parsePsTable(psTable);

  // paneId -> agentType, first allowlisted match per pane wins.
  const agentByPane = new Map<string, string>();
  for (const [pid, comm] of commByPid) {
    if (!opts.allowlist.has(comm)) continue;
    const paneId = walkToPane(pid, ppidByPid, panePids);
    if (paneId === null) continue;
    if (!agentByPane.has(paneId)) agentByPane.set(paneId, comm);
  }

  for (const [paneId, agentType] of agentByPane) {
    const glyph = GLYPH.test(captures.get(paneId) ?? '');
    if (glyph) {
      nextLastWorking.set(paneId, opts.now);
      agents.push({ paneId, agentType, working: true });
    } else {
      const last = opts.lastWorking.get(paneId);
      if (last !== undefined) nextLastWorking.set(paneId, last); // keep grace anchored to last glyph
      const working = last !== undefined && opts.now - last < opts.idleSecs;
      agents.push({ paneId, agentType, working });
    }
  }

  return { agents, lastWorking: nextLastWorking };
}

// ---- discovered-status fusion (pure) ----
//
// A discovered (hook-less) agent has three detection inputs, none authoritative:
// the braille spinner glyph from the process scan, the slow-cycle screen scrape
// (classified against the agent's OWN manifest), and the fast-cycle title match.
// resolveDiscoveredStatus fuses them and runs the DONE state machine, so a
// hook-less agent gets the full status vocabulary (PERMIT/QUESTION/BUSY/DONE/
// IDLE) instead of the old glyph-only BUSY/IDLE.

// Carried across ticks by the caller (module state in index.ts). wasBusy
// remembers panes last seen working so a working→idle transition is observable;
// done holds panes that finished while unfocused, until viewed or busy again.
// In-memory only: one-shot CLI invocations (fleet status) start cold and simply
// never synthesize DONE — same accepted fidelity loss as the glyph debounce.
export interface DoneTracking {
  wasBusy: Set<string>;
  done: Set<string>;
}

export interface DiscoveredSignals {
  glyphWorking: boolean; // discovery's debounced spinner-glyph read (slow cycle)
  scrape: AgentStatus | null; // right-manifest screen classification (slow cycle)
  title: AgentStatus | null; // title-rule classification (fast cycle)
  focused: boolean; // the user is looking at this pane right now
}

// Fuse one discovered pane's signals into its display status, updating
// `tracking` in place. Prompt/busy precedence is delegated to the engine's
// fuseDiscoveredState — the same fusion the hook path uses, so precedence rules
// can never drift between the tiers. The title takes the scrape slot when it
// fires (same rule as the hooked branch in refreshStates): it is re-read every
// fast tick while the scrape can be ~5s stale, so a live title signal outranks
// a lingering scraped prompt. On top of that base this layer runs the DONE
// state machine:
//   - a PERMIT/QUESTION base holds wasBusy open (the turn is still in flight),
//     so answering a prompt that ends the turn still lands on DONE;
//   - a BUSY base arms the working→idle transition;
//   - an IDLE base consumes the transition: DONE if it happened while
//     unfocused, cleared on view (focus) or when work resumes — the "finished
//     while you were elsewhere" semantic fleet's hook tier already has via
//     acknowledge.ts but the discovery tier lacked entirely.
export function resolveDiscoveredStatus(
  paneId: string,
  signals: DiscoveredSignals,
  tracking: DoneTracking,
  now: number,
): AgentStatus {
  const base = fuseDiscoveredState(signals.glyphWorking, signals.title ?? signals.scrape, now);

  // PERMIT/QUESTION hold wasBusy open (the turn is still in flight); BUSY arms
  // the working→idle transition — the tracking mutation is identical.
  if (base === AgentStatus.PERMIT || base === AgentStatus.QUESTION || base === AgentStatus.BUSY) {
    tracking.done.delete(paneId);
    tracking.wasBusy.add(paneId);
    return base;
  }

  if (tracking.wasBusy.has(paneId)) {
    tracking.wasBusy.delete(paneId);
    if (!signals.focused) tracking.done.add(paneId);
  }
  if (signals.focused) tracking.done.delete(paneId); // viewing the pane acknowledges it
  return tracking.done.has(paneId) ? AgentStatus.DONE : AgentStatus.IDLE;
}

// Drop tracking entries for panes discovery no longer sees (agent exited, pane
// closed) so the sets can't grow unboundedly across a long dashboard session.
export function pruneDoneTracking(tracking: DoneTracking, livePanes: ReadonlySet<string>): void {
  for (const id of tracking.wasBusy) {
    if (!livePanes.has(id)) tracking.wasBusy.delete(id);
  }
  for (const id of tracking.done) {
    if (!livePanes.has(id)) tracking.done.delete(id);
  }
}

// ---- config (pure parse + I/O read) ----

export interface DiscoveryConfig {
  enabled: boolean;
  allowlist: Set<string>;
  idleSecs: number;
}

// Conservative built-in allowlist. claude/codex/pi are harmless here — a hooked
// instance already won its pane in the hook branch, so discovery only ever labels
// a hook-LESS instance of them. User-overridable via @fleet_discover_agents.
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'claude',
  'codex',
  'pi',
  'aider',
  'cursor',
  'opencode',
  'gemini',
  'amp',
  'droid',
];
export const DEFAULT_IDLE_SECS = 3;

// Bottom-of-pane window the glyph check runs over — matches the manifest's
// default rule window (detection.ts DEFAULT_LINES_FROM_BOTTOM) so a spinner high
// in scrollback can't read as working.
const DISCOVERY_LINES = 15;

// Pure: turn the three raw tmux option strings (null = unset) into a config.
// @fleet_discover: `off` disables discovery entirely (default on).
// @fleet_discover_agents: comma-separated allowlist override.
// @fleet_discover_idle_secs: debounce grace in seconds.
export function parseDiscoveryConfig(raw: {
  discover: string | null;
  agents: string | null;
  idleSecs: string | null;
}): DiscoveryConfig {
  const enabled = raw.discover?.trim() !== 'off';

  const allowlist = raw.agents
    ? new Set(
        raw.agents
          .split(',')
          .map((s) => normalizeComm(s))
          .filter((s) => s.length > 0),
      )
    : new Set<string>(DEFAULT_ALLOWLIST);

  const parsed = raw.idleSecs ? parseInt(raw.idleSecs, 10) : NaN;
  const idleSecs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_SECS;

  return { enabled, allowlist, idleSecs };
}

// ---- I/O shell: spawn ps, call tmux, read config, delegate to the pure core ----

// The @fleet_discover* options essentially never change mid-session, but a
// cold read costs 3 tmux spawns — cache with a TTL so live option changes
// still land within a minute.
const CONFIG_TTL_MS = 60_000;
let cachedConfig: { cfg: DiscoveryConfig; readAt: number } | null = null;

export function readDiscoveryConfig(): DiscoveryConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.readAt < CONFIG_TTL_MS) return cachedConfig.cfg;
  const cfg = parseDiscoveryConfig({
    discover: getTmuxOption('@fleet_discover'),
    agents: getTmuxOption('@fleet_discover_agents'),
    idleSecs: getTmuxOption('@fleet_discover_idle_secs'),
  });
  cachedConfig = { cfg, readAt: now };
  return cfg;
}

// One `ps` pass over the whole process table. Empty on any failure (exotic
// platform / different flags) so discovery degrades to no-op and fleet behaves as
// pre-Phase-3 (the pane stays SHELL).
export function readPsTable(): string[] {
  try {
    const p = Bun.spawnSync({ cmd: ['ps', '-eo', 'pid=,ppid=,comm='], stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) return [];
    return p.stdout.toString().split('\n');
  } catch {
    return [];
  }
}

// Thin I/O wrapper the slow loop calls. `captures` are the per-pane lines already
// taken for the scrape cache this tick (paneId -> captured lines), and `panePids`
// + `psTable` come from the caller's single list-panes + ps pass, so discovery
// adds ZERO extra subprocess spawns. `lastWorking` is carried across ticks by the
// caller. Returns the discovered agents plus the pruned lastWorking to persist
// for the next tick.
export function scanDiscovered(
  captures: Map<string, string[]>,
  panePids: Map<number, string>,
  psTable: string[],
  lastWorking: Map<string, number>,
  now: number,
  config?: DiscoveryConfig,
): { agents: DiscoveredAgent[]; lastWorking: Map<string, number> } {
  const cfg = config ?? readDiscoveryConfig();
  if (!cfg.enabled) return { agents: [], lastWorking: new Map() };

  // Reduce each pane's captured lines to the bottom-of-pane window as one string
  // for the glyph check.
  const captureStrings = new Map<string, string>();
  for (const [paneId, lines] of captures) {
    captureStrings.set(paneId, lines.slice(-DISCOVERY_LINES).join('\n'));
  }

  return discoverAgents(psTable, panePids, captureStrings, {
    allowlist: cfg.allowlist,
    idleSecs: cfg.idleSecs,
    now,
    lastWorking,
  });
}
