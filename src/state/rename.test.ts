import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRenames, saveRename } from './rename.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-rename-test-'));
  path = join(dir, 'renames.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rename store', () => {
  test('round-trip: save then load returns the value', () => {
    saveRename('s', 'Label', path);
    expect(loadRenames(path).get('s')).toBe('Label');
  });

  test('persistence across reload (simulated restart)', () => {
    saveRename('api-server', 'prod hotfix', path);
    // A fresh load with no shared in-memory state — the contract's persistence criterion.
    const reloaded = loadRenames(path);
    expect(reloaded.get('api-server')).toBe('prod hotfix');
  });

  test('empty label clears the key', () => {
    saveRename('s', 'Label', path);
    saveRename('s', '', path);
    expect(loadRenames(path).has('s')).toBe(false);
  });

  test('whitespace-only label clears the key', () => {
    saveRename('s', 'Label', path);
    saveRename('s', '   ', path);
    expect(loadRenames(path).has('s')).toBe(false);
  });

  test('label is trimmed on save', () => {
    saveRename('s', '  padded  ', path);
    expect(loadRenames(path).get('s')).toBe('padded');
  });

  test('corrupt file yields an empty map without throwing', () => {
    writeFileSync(path, '{not valid json');
    expect(loadRenames(path).size).toBe(0);
  });

  test('missing file yields an empty map without throwing', () => {
    const missing = join(dir, 'does-not-exist.json');
    expect(existsSync(missing)).toBe(false);
    expect(loadRenames(missing).size).toBe(0);
  });

  test('non-object JSON (array) yields an empty map', () => {
    writeFileSync(path, '["a","b"]');
    expect(loadRenames(path).size).toBe(0);
  });

  test('non-string values are ignored', () => {
    writeFileSync(path, JSON.stringify({ good: 'ok', bad: 42, empty: '' }));
    const map = loadRenames(path);
    expect(map.get('good')).toBe('ok');
    expect(map.has('bad')).toBe(false);
    expect(map.has('empty')).toBe(false);
  });

  test('multi-key isolation: renaming one session leaves others intact', () => {
    saveRename('one', 'first', path);
    saveRename('two', 'second', path);
    saveRename('one', 'first-updated', path);
    const map = loadRenames(path);
    expect(map.get('one')).toBe('first-updated');
    expect(map.get('two')).toBe('second');
  });
});
