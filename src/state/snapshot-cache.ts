import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxSocketId } from './segment-cache.ts';
import { AgentStatus, type AgentState } from './types.ts';

const CACHE_VERSION = 1;
const WRITE_INTERVAL_MS = 5_000;
let lastPayload = '';
let lastWriteMs = 0;

function cacheDirPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `fleet-${uid}`);
}

function ensurePrivateCacheDir(): boolean {
  try {
    const dir = cacheDirPath();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.uid !== uid) return false;
    chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

export function snapshotCacheFilePath(): string {
  return join(cacheDirPath(), `agents-${tmuxSocketId()}.json`);
}

// The running TUI publishes its last known-good snapshot. Query commands only
// read this file; they never mutate persistent state. Rewriting at most every
// five seconds keeps the cache fresh without putting the hot 500ms tick on disk.
export function writeAgentSnapshot(states: AgentState[], now = Date.now()): void {
  try {
    if (!ensurePrivateCacheDir()) return;
    const payload = JSON.stringify({ version: CACHE_VERSION, writtenAt: now, states });
    if (payload === lastPayload && now - lastWriteMs < WRITE_INTERVAL_MS) return;
    const path = snapshotCacheFilePath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, payload, { mode: 0o600 });
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
    if (!ensurePrivateCacheDir()) return null;
    const path = snapshotCacheFilePath();
    const stat = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.uid !== uid) return null;
    const ageSecs = (Date.now() - stat.mtimeMs) / 1000;
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
