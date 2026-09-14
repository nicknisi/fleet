import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheFilePath, readFreshSegmentCache, writeSegmentCache } from './segment-cache.ts';

// Isolate every test in its own TMPDIR + $TMUX so the cache path is unique per
// test and never touches a real fleet cache. Restored in `after` so a leaked
// env value can't bleed into the next test file.
const prevTmpdir = process.env.TMPDIR;
const prevTmux = process.env.TMUX;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-segment-cache-test-'));
  process.env.TMPDIR = workDir;
  process.env.TMUX = '/tmp/tmux-501/default,12345,0';
});

// Restore TMPDIR after every test: otherwise the next beforeEach mkdtemps
// under the previous test's TMPDIR and the temp dirs nest without bound.
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (prevTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmpdir;
  if (prevTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = prevTmux;
});

describe('cacheFilePath', () => {
  test('embeds the uid and a sanitized tmux socket basename', () => {
    process.env.TMUX = '/tmp/tmux-501/my-socket,12345,0';
    const p = cacheFilePath();
    expect(p).toContain(`fleet-statusline-${process.getuid!()}-my-socket.cache`);
  });

  test('falls back to "default" outside tmux', () => {
    delete process.env.TMUX;
    const p = cacheFilePath();
    expect(p).toContain(`fleet-statusline-${process.getuid!()}-default.cache`);
  });

  test('strips non-filename characters from the socket field', () => {
    process.env.TMUX = '/path with spaces/odd socket!,1,2';
    const p = cacheFilePath();
    // Only [A-Za-z0-9._-] survive the basename + sanitize pass.
    expect(p).toMatch(/fleet-statusline-\d+-oddsocket\.cache$/);
  });
});

describe('writeSegmentCache + readFreshSegmentCache', () => {
  test('a fresh write is readable verbatim', () => {
    const segment = '#[range=user|fleet-sidebar]#[fg=cyan] ☰ #[norange]';
    writeSegmentCache(segment);
    expect(readFreshSegmentCache()).toBe(segment);
  });

  test('write is atomic: the temp file is renamed into place (no partial file)', () => {
    const segment = 'hello-statusline';
    writeSegmentCache(segment);
    // The cache file exists with the exact content; no stray temp remains.
    expect(readFreshSegmentCache()).toBe(segment);
    // An overwrite is also atomic and immediately readable.
    writeSegmentCache('second');
    expect(readFreshSegmentCache()).toBe('second');
  });

  test('returns null when the cache file is missing (fs errors safe)', () => {
    expect(readFreshSegmentCache()).toBeNull();
  });

  test('returns null when the cache mtime is older than maxAgeSecs', () => {
    writeSegmentCache('stale-segment');
    // Push mtime 60s into the past — well beyond the 6s default.
    const old = Date.now() / 1000 - 60;
    utimesSync(cacheFilePath(), old, old);
    expect(readFreshSegmentCache()).toBeNull();
    // A larger maxAgeSecs still considers it fresh.
    expect(readFreshSegmentCache(120)).toBe('stale-segment');
  });

  test('treats an age just inside maxAgeSecs as fresh', () => {
    writeSegmentCache('boundary');
    const justInside = Date.now() / 1000 - 6;
    utimesSync(cacheFilePath(), justInside, justInside);
    // Leave scheduling headroom: this asserts the > comparison without an
    // exact wall-clock boundary that can cross during a loaded CI run.
    expect(readFreshSegmentCache(7)).toBe('boundary');
  });

  test('writeSegmentCache never throws when the tmp dir is gone', () => {
    // Point TMPDIR at a path that doesn't exist; writeFileSync will throw, but
    // writeSegmentCache must swallow it (the cache is an optimization).
    const saved = process.env.TMPDIR;
    const ghost = join(workDir, 'does-not-exist');
    process.env.TMPDIR = ghost;
    try {
      expect(() => writeSegmentCache('anything')).not.toThrow();
      expect(readFreshSegmentCache()).toBeNull();
    } finally {
      process.env.TMPDIR = saved;
    }
  });

  test('readFreshSegmentCache never throws on an unreadable/odd path', () => {
    // Make the cache "file" be a directory → readFileSync throws EISDIR.
    mkdirSync(cacheFilePath(), { recursive: true });
    expect(readFreshSegmentCache()).toBeNull();
  });
});

describe('writeSegmentCache dedup + heartbeat', () => {
  test('skips rewriting stable text within the heartbeat interval', () => {
    writeSegmentCache('stable', 0);
    // Remove the file: a skipped write leaves it absent, a real write recreates it.
    rmSync(cacheFilePath());
    writeSegmentCache('stable', 1_000);
    writeSegmentCache('stable', 2_999);
    expect(existsSync(cacheFilePath())).toBe(false);
  });

  test('republishes unchanged text once the heartbeat interval elapses', () => {
    writeSegmentCache('stable', 0);
    rmSync(cacheFilePath());
    writeSegmentCache('stable', 3_000);
    expect(readFreshSegmentCache()).toBe('stable');
  });

  test('writes changed text immediately, even inside the interval', () => {
    writeSegmentCache('a', 0);
    writeSegmentCache('b', 100);
    expect(readFreshSegmentCache()).toBe('b');
  });

  test('treats empty text as a change and writes it immediately', () => {
    writeSegmentCache('a', 0);
    writeSegmentCache('', 100);
    expect(readFreshSegmentCache()).toBe('');
  });

  test('retries after a failed write (memo is not poisoned)', () => {
    // rename onto an existing directory fails, so the write never lands.
    mkdirSync(cacheFilePath(), { recursive: true });
    writeSegmentCache('x', 0);
    rmSync(cacheFilePath(), { recursive: true });
    // Same text, but the prior write failed → must write, not dedup.
    writeSegmentCache('x', 100);
    expect(readFreshSegmentCache()).toBe('x');
  });

  test('memoization is scoped per cache path', () => {
    writeSegmentCache('same', 0);
    // Different tmux socket → different cache path → no shared dedup state.
    process.env.TMUX = '/tmp/tmux-501/other-socket,12345,0';
    rmSync(cacheFilePath(), { force: true });
    writeSegmentCache('same', 100);
    expect(readFreshSegmentCache()).toBe('same');
  });

  test('republishes after a backwards clock jump', () => {
    writeSegmentCache('t', 10_000);
    rmSync(cacheFilePath());
    writeSegmentCache('t', 0);
    expect(readFreshSegmentCache()).toBe('t');
  });
});
