import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStatusFile, readAllStatusDirs, readStatusDir } from './hooks.ts';
import type { ResolvedHookStatus } from './types.ts';

describe('parseStatusFile', () => {
  test('parses valid status JSON', () => {
    const content =
      '{"state":"working","pane":"%42","session":"dotfiles","tool":"Edit","ts":1748380000,"tmux_pid":12345}';
    const status = parseStatusFile(content);
    expect(status).not.toBeNull();
    expect(status!.state).toBe('working');
    expect(status!.pane).toBe('%42');
    expect(status!.session).toBe('dotfiles');
    expect(status!.tool).toBe('Edit');
  });

  test('returns null for invalid JSON', () => {
    expect(parseStatusFile('not json')).toBeNull();
    expect(parseStatusFile('')).toBeNull();
  });
});

describe('readStatusDir', () => {
  test('returns empty for non-existent dir', () => {
    expect(readStatusDir('/tmp/nonexistent-fleet-test-dir', 'claude')).toEqual([]);
  });
});

// Agent-identity threading (Phase 3): each on-disk status is stamped with the
// owning agent name and source dir, so index.ts can set agentType from `agent`
// and read the matching .events.jsonl from `statusDir` without re-deriving.
describe('readAllStatusDirs stamps agent + statusDir', () => {
  let root: string;
  let claudeDir: string;
  let codexDir: string;

  const writeStatus = (dir: string, paneNum: number, pane: string, ts: number, state = 'working') => {
    writeFileSync(
      join(dir, `${paneNum}.status`),
      JSON.stringify({ state, pane, session: 's', tool: 'Bash', ts, tmux_pid: 1 }) + '\n',
    );
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleet-hooks-test-'));
    claudeDir = join(root, 'claude');
    codexDir = join(root, 'codex');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('each record carries its owning dir name + path', () => {
    writeStatus(claudeDir, 1, '%1', 100);
    writeStatus(codexDir, 2, '%2', 100);

    const all = readAllStatusDirs([
      { name: 'claude', statusDir: claudeDir },
      { name: 'codex', statusDir: codexDir },
    ]);
    expect(all).toHaveLength(2);
    const byPane = new Map(all.map((h: ResolvedHookStatus) => [h.pane, h]));

    expect(byPane.get('%1')!.agent).toBe('claude');
    expect(byPane.get('%1')!.statusDir).toBe(claudeDir);
    expect(byPane.get('%2')!.agent).toBe('codex');
    expect(byPane.get('%2')!.statusDir).toBe(codexDir);
  });

  test('same pane number in both dirs: both returned; freshness reduction keeps the newer', () => {
    // Server-global tmux pane id %7 written in both dirs with different ts.
    writeStatus(claudeDir, 7, '%7', 100);
    writeStatus(codexDir, 7, '%7', 200);

    const all = readAllStatusDirs([
      { name: 'claude', statusDir: claudeDir },
      { name: 'codex', statusDir: codexDir },
    ]);
    expect(all).toHaveLength(2);

    // Same freshness-wins rule index.ts uses to build hookByPane.
    const byPane = new Map<string, ResolvedHookStatus>();
    for (const h of all) {
      const prev = byPane.get(h.pane);
      if (!prev || h.ts > prev.ts) byPane.set(h.pane, h);
    }
    expect(byPane.get('%7')!.agent).toBe('codex');
    expect(byPane.get('%7')!.ts).toBe(200);
    expect(byPane.get('%7')!.statusDir).toBe(codexDir);
  });
});
