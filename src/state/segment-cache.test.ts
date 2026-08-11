import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
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

afterAll(() => {
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

  test('treats the boundary as fresh: age == maxAgeSecs is NOT stale', () => {
    writeSegmentCache('boundary');
    const exactly = Date.now() / 1000 - 6;
    utimesSync(cacheFilePath(), exactly, exactly);
    // ageSecs > maxAgeSecs is the gate, so age == 6 is still fresh.
    expect(readFreshSegmentCache(6)).toBe('boundary');
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
