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
function tmuxSocketId(): string {
  const tmux = process.env.TMUX;
  if (!tmux || tmux.length === 0) return 'default';
  const firstField = tmux.split(',')[0] ?? '';
  if (firstField.length === 0) return 'default';
  const base = firstField.split('/').pop() ?? '';
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '');
  return sanitized.length > 0 ? sanitized : 'default';
}

export function cacheFilePath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `fleet-statusline-${uid}-${tmuxSocketId()}.cache`);
}

// Atomic write: write a temp file beside the target then rename. rename is
// atomic on the same filesystem, so a concurrent reader never sees a partial
// segment. Never throws — a cache write failure is non-fatal; the worst case is
// the CLI falls back to a live compute on the next status-interval.
export function writeSegmentCache(segment: string): void {
  try {
    const path = cacheFilePath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, segment);
    renameSync(tmp, path);
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
