import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStatus, type AgentState } from './types.ts';
import {
  __resetSnapshotCacheForTests,
  readFreshAgentSnapshot,
  snapshotCacheFilePath,
  writeAgentSnapshot,
} from './snapshot-cache.ts';

const previousTmux = process.env.TMUX;
const previousTmpdir = process.env.TMPDIR;
let testTmpdir = '';
const state: AgentState = {
  paneId: '%42',
  paneNum: 42,
  session: 'api',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.DONE,
  tool: null,
  project: '/tmp/api',
  branch: 'main',
  ports: [],
  ts: 100,
  agentType: 'claude',
  tracking: 'hook',
};

beforeEach(() => {
  testTmpdir = mkdtempSync(join(tmpdir(), 'fleet-snapshot-test-'));
  process.env.TMPDIR = testTmpdir;
  process.env.TMUX = '/tmp/fleet-snapshot-test.sock,123,0';
  __resetSnapshotCacheForTests();
});

afterEach(() => {
  rmSync(testTmpdir, { recursive: true, force: true });
  __resetSnapshotCacheForTests();
  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
});

describe('agent snapshot cache', () => {
  test('is scoped by private temp dir and tmux socket', () => {
    process.env.TMUX = '/tmp/private.sock,123,0';
    expect(snapshotCacheFilePath().startsWith(testTmpdir)).toBe(true);
    expect(snapshotCacheFilePath()).toContain('private.sock');
  });

  test('round-trips a valid last-known snapshot', () => {
    writeAgentSnapshot([state]);
    expect(readFreshAgentSnapshot()).toEqual([state]);
  });

  test('returns null for a stale snapshot', () => {
    writeAgentSnapshot([state]);
    const old = new Date(Date.now() - 10_000);
    utimesSync(snapshotCacheFilePath(), old, old);
    expect(readFreshAgentSnapshot(1)).toBeNull();
  });

  test('returns null when the cache is missing', () => {
    expect(readFreshAgentSnapshot()).toBeNull();
  });

  test('publishes at most once per five seconds even as state changes', () => {
    // The hot 500ms tick calls this repeatedly; only the first write in a
    // five-second window reaches disk, regardless of state churn.
    writeAgentSnapshot([state], 0);
    expect(readFreshAgentSnapshot()).toEqual([state]);
    const changed: AgentState = { ...state, status: AgentStatus.BUSY };
    writeAgentSnapshot([changed], 500);
    writeAgentSnapshot([changed], 4_999);
    // Still the first snapshot: within the 5s gate nothing was rewritten.
    expect(readFreshAgentSnapshot()).toEqual([state]);
    writeAgentSnapshot([changed], 5_000);
    expect(readFreshAgentSnapshot()).toEqual([changed]);
  });

  test('the gate short-circuits before serialization', () => {
    writeAgentSnapshot([state], 1_000);
    const original = readFileSync(snapshotCacheFilePath(), 'utf8');
    let serialized = false;
    const next: AgentState = {
      ...state,
      get status() {
        serialized = true;
        return AgentStatus.BUSY;
      },
    };
    writeAgentSnapshot([next], 2_000);
    expect(serialized).toBe(false);
    expect(readFileSync(snapshotCacheFilePath(), 'utf8')).toBe(original);
  });

  test('republishes immediately after a backwards clock jump', () => {
    writeAgentSnapshot([state], 10_000);
    const changed: AgentState = { ...state, status: AgentStatus.BUSY };
    // Clock moved backwards (NTP correction, host resume): don't stall.
    writeAgentSnapshot([changed], 0);
    expect(readFreshAgentSnapshot()).toEqual([changed]);
  });
});
