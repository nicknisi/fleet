import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxSocketId } from './segment-cache.ts';
import { AgentStatus, type AgentState } from './types.ts';

const CACHE_VERSION = 1;
const WRITE_INTERVAL_MS = 5_000;
let lastPayload = '';
let lastWriteMs = 0;

export function snapshotCacheFilePath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `fleet-agents-${uid}-${tmuxSocketId()}.json`);
}

// The running TUI publishes its last known-good snapshot. Query commands only
// read this file; they never mutate persistent state. Rewriting at most every
// five seconds keeps the cache fresh without putting the hot 500ms tick on disk.
export function writeAgentSnapshot(states: AgentState[], now = Date.now()): void {
  try {
    const payload = JSON.stringify({ version: CACHE_VERSION, writtenAt: now, states });
    if (payload === lastPayload && now - lastWriteMs < WRITE_INTERVAL_MS) return;
    const path = snapshotCacheFilePath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
    lastPayload = payload;
    lastWriteMs = now;
  } catch {
    // Cache publication is best-effort; live observation remains authoritative.
  }
}

function isAgentState(value: unknown): value is AgentState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<AgentState>;
  return (
    typeof state.paneId === 'string' &&
    typeof state.session === 'string' &&
    typeof state.window === 'string' &&
    typeof state.agentType === 'string' &&
    Object.values(AgentStatus).includes(state.status as AgentStatus)
  );
}

// null means missing, too old, malformed, or from an incompatible cache
// version. Callers then report tmux_unavailable rather than pretending they
// have useful stale data.
export function readFreshAgentSnapshot(maxAgeSecs = 300): AgentState[] | null {
  try {
    const path = snapshotCacheFilePath();
    const ageSecs = (Date.now() - statSync(path).mtimeMs) / 1000;
    if (ageSecs > maxAgeSecs) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; states?: unknown };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.states)) return null;
    if (!parsed.states.every(isAgentState)) return null;
    return parsed.states;
  } catch {
    return null;
  }
}

export function __resetSnapshotCacheForTests(): void {
  lastPayload = '';
  lastWriteMs = 0;
}
