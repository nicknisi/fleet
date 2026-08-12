// Best-effort workmux adapter. workmux (https://github.com/) is an optional,
// external worktree/pane manager some users drive alongside fleet. This adapter
// is a strictly read-only enrichment layer: when workmux is installed it reads
// `workmux status --json` once per slow tick, parses it into a path/pane lookup,
// and annotates matching agents so the TUI/CLI can offer a "jump via workmux"
// action. Fleet's core detection NEVER depends on workmux — every function here
// degrades to empty/absent on any failure, and nothing else in the state engine
// imports it into the hot path.
//
// Invariants:
//   - Availability is memoized (one `Bun.which` lookup per process).
//   - One global `workmux status --json` spawn per slow tick, only when
//     installed. Zero fast-tick subprocesses.
//   - Pure parser (parseWorkmuxStatus) never spawns or touches disk.
//   - Graceful empty on any failure — never throws.

import { tmpdir } from 'node:os';

export interface WorkmuxEntry {
  // Absolute worktree/session path workmux manages, used to match a pane's
  // worktree root (or cwd) to a workmux-managed handle.
  path: string;
  // The opaque handle workmux uses to open/focus this entry (session or window
  // name). Passed back to `workmux open <handle>` verbatim.
  handle: string;
  // Optional tmux pane id when workmux reports one, for a direct pane match.
  pane: string | null;
}

// The read-only enrichment attached to an AgentState / AgentView. `managed`
// distinguishes "workmux is installed and claims this pane" from "not managed".
export interface WorkmuxEnrichment {
  managed: true;
  handle: string;
  path: string;
}

export interface WorkmuxStatus {
  entries: WorkmuxEntry[];
}

// --- Pure parser ----------------------------------------------------------

// Parse `workmux status --json`. The shape is defensively narrowed: we accept
// either a top-level array of entries or an object with a `worktrees`/`sessions`
// array, and pull path + a handle + an optional pane from each. Anything
// unparseable yields an empty status rather than throwing.
export function parseWorkmuxStatus(stdout: string): WorkmuxStatus {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { entries: [] };
  }

  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? (asArray(raw.agents) ?? asArray(raw.worktrees) ?? asArray(raw.sessions) ?? asArray(raw.entries) ?? [])
      : [];

  const entries: WorkmuxEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const worktree = firstString(row, ['worktree']);
    const path = firstString(row, ['workdir', 'path', 'root', 'dir']) ?? (worktree?.startsWith('/') ? worktree : null); // legacy adapters used worktree as a path
    if (!path) continue;
    const handle =
      (worktree && !worktree.startsWith('/') ? worktree : null) ??
      firstString(row, ['handle', 'name', 'session', 'window_name', 'window', 'id']);
    // Enrichment may still match by path, but the explicit open action is only
    // safe when workmux reported an opaque handle. Never guess with a path.
    if (!handle) continue;
    const pane = firstString(row, ['pane', 'pane_id', 'paneId']);
    entries.push({ path, handle, pane: pane ?? null });
  }
  return { entries };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// --- Availability + spawn -------------------------------------------------

let availabilityMemo: boolean | null = null;

// Memoized "is workmux on PATH". Bun.which is a cheap, read-only lookup; we do
// it at most once per process. Exposed reset for tests.
export function isWorkmuxAvailable(): boolean {
  if (availabilityMemo === null) {
    availabilityMemo = Bun.which('workmux') !== null;
  }
  return availabilityMemo;
}

export function __resetWorkmuxMemoForTests(): void {
  availabilityMemo = null;
}

// One bounded `workmux status --json` spawn. Returns empty when workmux is not
// installed or the command fails/misbehaves. Never throws.
export function readWorkmuxStatus(): WorkmuxStatus {
  if (!isWorkmuxAvailable()) return { entries: [] };
  try {
    const proc = Bun.spawnSync({
      cmd: ['workmux', 'status', '--json'],
      cwd: tmpdir(), // outside the current repo so workmux reports global agents
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return { entries: [] };
    return parseWorkmuxStatus(proc.stdout.toString());
  } catch {
    return { entries: [] };
  }
}

// --- Matching -------------------------------------------------------------

// Build a lookup from a workmux status: by absolute path and by pane id. The
// caller matches a pane's worktree root (preferred) or cwd against the path
// index, or its pane id against the pane index.
export interface WorkmuxIndex {
  byPath: Map<string, WorkmuxEntry>;
  byPane: Map<string, WorkmuxEntry>;
}

export function indexWorkmux(status: WorkmuxStatus): WorkmuxIndex {
  const byPath = new Map<string, WorkmuxEntry>();
  const byPane = new Map<string, WorkmuxEntry>();
  for (const e of status.entries) {
    byPath.set(e.path, e);
    if (e.pane) byPane.set(e.pane, e);
  }
  return { byPath, byPane };
}

// Resolve the workmux entry for a pane given its id and candidate paths (the
// worktree root and the raw cwd). Pane id wins over path. null when unmanaged.
export function matchWorkmux(
  index: WorkmuxIndex,
  paneId: string,
  paths: (string | null | undefined)[],
): WorkmuxEntry | null {
  const concretePaths = paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  const byPane = index.byPane.get(paneId);
  // Pane ids are unique only within one tmux server. Require path agreement as
  // a second factor before accepting a pane-id hit from global workmux state.
  if (byPane && concretePaths.includes(byPane.path)) return byPane;
  for (const p of concretePaths) {
    if (!p) continue;
    const hit = index.byPath.get(p);
    if (hit) return hit;
  }
  return null;
}

// Invoke `workmux open <handle>`. Direct argv (no shell). Returns the exit code
// and captured stderr for the CLI to surface. Never throws.
export function workmuxOpen(handle: string): { code: number; stderr: string } {
  try {
    const proc = Bun.spawnSync({
      cmd: ['workmux', 'open', handle],
      stdout: 'inherit',
      stderr: 'pipe',
    });
    return { code: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
  } catch (err) {
    return { code: 1, stderr: String(err) };
  }
}
