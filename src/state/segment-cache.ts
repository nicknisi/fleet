import { tmpdir } from 'node:os';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// tmux's `status-format[1]` runs `#(fleet status --statusline)` every
// status-interval, and each invocation cold-boots Bun and recomputes the full
// agent state — work the running TUI already does every FAST_REFRESH_MS. This
// module is the cache the running process refreshes and the CLI reads: the CLI
// serves the cached segment when fresh and only falls back to a live compute
// when the cache is stale (TUI closed, machine slept, …).
//
// Reference pattern: tmux-agents-mon cmd_status serves from a cache file the
// running process refreshes; live-compute only when the cache mtime is older
// than a few seconds.

// $TMUX is `<socket>,<pid>,<session-id>` (the first comma-field is the socket
// path). We basename it so an absolute socket path doesn't leak filesystem
// layout into the cache filename, strip anything that isn't filename-safe, and
// fall back to 'default' outside tmux. Embedding the socket keeps caches from
// two distinct tmux servers from colliding, and the uid keeps them from
// colliding across users on a shared tmpdir.
export function tmuxSocketId(): string {
  const tmux = process.env.TMUX;
  if (!tmux || tmux.length === 0) return 'default';
  const firstField = tmux.split(',')[0] ?? '';
  if (firstField.length === 0) return 'default';
  const base = firstField.split('/').pop() ?? '';
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '');
  return sanitized.length > 0 ? sanitized : 'default';
}

export function cacheFilePath(): string {
  const uid = process.getuid?.() ?? 0;
  return join(tmpdir(), `fleet-statusline-${uid}-${tmuxSocketId()}.cache`);
}

// The running TUI calls this every tick. This writer owns both deduplication
// and the freshness heartbeat: it skips rewriting identical text until the
// heartbeat interval elapses, then republishes so the reader's 6s TTL never
// expires on a still-live TUI. Changed text (including empty text) is written
// immediately.
const HEARTBEAT_INTERVAL_MS = 3_000;
// Keyed by cache path so distinct TMPDIR/$TMUX (e.g. isolated tests) never share
// dedup state. Only updated on a successful write, so a failed write retries on
// the next tick rather than being deduplicated away.
const lastWriteByPath = new Map<string, { segment: string; writtenMs: number }>();

// Atomic write: write a temp file beside the target then rename. rename is
// atomic on the same filesystem, so a concurrent reader never sees a partial
// segment. Never throws — a cache write failure is non-fatal; the worst case is
// the CLI falls back to a live compute on the next status-interval.
export function writeSegmentCache(segment: string, now = Date.now()): void {
  try {
    const path = cacheFilePath();
    const last = lastWriteByPath.get(path);
    // Dedup unchanged text until the heartbeat is due. A backwards clock jump
    // (now < last.writtenMs) republishes immediately instead of stalling.
    if (
      last !== undefined &&
      last.segment === segment &&
      now >= last.writtenMs &&
      now - last.writtenMs < HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, segment);
    renameSync(tmp, path);
    lastWriteByPath.set(path, { segment, writtenMs: now });
  } catch {
    // Swallow: the cache is an optimization, not a correctness requirement.
  }
}

// null on missing/stale/any fs error. maxAgeSecs bounds staleness: the running
// TUI refreshes every 500ms, so 6s covers ~12 missed refreshes before the CLI
// falls back to a live compute (TUI closed, machine slept, …). Never throws.
export function readFreshSegmentCache(maxAgeSecs = 6): string | null {
  try {
    const path = cacheFilePath();
    const st = statSync(path);
    const ageSecs = (Date.now() - st.mtimeMs) / 1000;
    if (ageSecs > maxAgeSecs) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
