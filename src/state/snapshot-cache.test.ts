import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, utimesSync } from 'node:fs';
import { AgentStatus, type AgentState } from './types.ts';
import {
  __resetSnapshotCacheForTests,
  readFreshAgentSnapshot,
  snapshotCacheFilePath,
  writeAgentSnapshot,
} from './snapshot-cache.ts';

const previousTmux = process.env.TMUX;
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

afterEach(() => {
  rmSync(snapshotCacheFilePath(), { force: true });
  __resetSnapshotCacheForTests();
  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;
});

describe('agent snapshot cache', () => {
  test('is scoped by tmux socket', () => {
    process.env.TMUX = '/tmp/private.sock,123,0';
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
});
