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

function showOption(name: string): string | null {
  try {
    const p = Bun.spawnSync({ cmd: ['tmux', 'show', '-gqv', name], stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) return null;
    const v = p.stdout.toString().trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function readDiscoveryConfig(): DiscoveryConfig {
  return parseDiscoveryConfig({
    discover: showOption('@fleet_discover'),
    agents: showOption('@fleet_discover_agents'),
    idleSecs: showOption('@fleet_discover_idle_secs'),
  });
}

// Build the pane_pid -> paneId map from one `tmux list-panes` call (pattern:
// ports.ts:8-22). Empty on any tmux failure.
function readPanePids(): Map<number, string> {
  const panePids = new Map<number, string>();
  try {
    const p = Bun.spawnSync({
      cmd: ['tmux', 'list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (p.exitCode !== 0) return panePids;
    for (const line of p.stdout.toString().split('\n')) {
      if (line.length === 0) continue;
      const [paneId, pidStr] = line.split(':');
      if (paneId && pidStr) {
        const pid = parseInt(pidStr, 10);
        if (!Number.isNaN(pid)) panePids.set(pid, paneId);
      }
    }
  } catch {
    return panePids;
  }
  return panePids;
}

// One `ps` pass over the whole process table. Empty on any failure (exotic
// platform / different flags) so discovery degrades to no-op and fleet behaves as
// pre-Phase-3 (the pane stays SHELL).
function readPsTable(): string[] {
  try {
    const p = Bun.spawnSync({ cmd: ['ps', '-eo', 'pid=,ppid=,comm='], stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) return [];
    return p.stdout.toString().split('\n');
  } catch {
    return [];
  }
}

// Thin I/O wrapper the slow loop calls. `captures` are the per-pane lines already
// taken for the scrape cache this tick (paneId -> captured lines), threaded in so
// discovery adds ZERO extra capture-pane calls — only one `ps` and one
// `list-panes`. `lastWorking` is carried across ticks by the caller. Returns the
// discovered agents plus the pruned lastWorking to persist for the next tick.
export function scanDiscovered(
  captures: Map<string, string[]>,
  lastWorking: Map<string, number>,
  now: number,
  config?: DiscoveryConfig,
): { agents: DiscoveredAgent[]; lastWorking: Map<string, number> } {
  const cfg = config ?? readDiscoveryConfig();
  if (!cfg.enabled) return { agents: [], lastWorking: new Map() };

  const panePids = readPanePids();
  const psTable = readPsTable();

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
