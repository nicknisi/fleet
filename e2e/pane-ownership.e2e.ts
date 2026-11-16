import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateTmux } from './private-tmux.ts';

test('CLI ignores stale owners, selects the live scraper and survives a session rename', async () => {
  const { root, tm, waitFor, close } = privateTmux('fleet-owner-');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const current = join(root, 'current');
  const old = join(root, 'old');
  for (const path of [home, current, old]) mkdirSync(path, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, 'cache'), TMUX: '' };
  try {
    tm(
      'new-session',
      '-d',
      '-s',
      'current-session',
      '-x',
      '100',
      '-y',
      '35',
      'python3',
      '-u',
      '-c',
      "import time\nprint('enter submit ^] skip shift+→ main prompt',flush=True)\ntime.sleep(60)",
    );
    await waitFor(() => tm('capture-pane', '-p', '-t', 'current-session').includes('^] skip'));
    const pane = tm('display-message', '-p', '-t', 'current-session', '#{pane_id}');
    const server = Number(tm('display-message', '-p', '#{pid}'));
    env.TMUX = `${join(root, 'tmux.sock')},${server},0`;
    writeFileSync(
      join(config, 'fleet/agents.json'),
      JSON.stringify({
        agents: [
          { name: 'codex', statusDir: current },
          { name: 'claude', statusDir: old },
        ],
      }),
    );
    const status = {
      pane,
      session: 'current-session',
      state: 'working',
      tool: 'current work',
      name: 'Current agent',
      ts: Math.floor(Date.now() / 1000),
      tmux_pid: server,
    };
    writeFileSync(join(current, `${pane.slice(1)}.status`), JSON.stringify(status));
    for (const owner of [
      { session: 'old-session', tmux_pid: 0 },
      { session: 'current-session', tmux_pid: server + 1 },
    ]) {
      writeFileSync(
        join(old, `${pane.slice(1)}.status`),
        JSON.stringify({ ...status, ...owner, ts: 9999999999, name: 'Old agent', tool: 'stale work' }),
      );
      const result = Bun.spawnSync(
        [process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'), 'list', '--json'],
        { env },
      );
      expect(result.exitCode).toBe(0);
      const agent = JSON.parse(result.stdout.toString()).agents.find((row: { pane: string }) => row.pane === pane);
      expect(agent.agentType).toBe('codex');
      expect(agent.label).toBe('Current agent');
      expect(agent.tool).toBe('current work');
      expect(agent.status).toBe('QUESTION');
    }
    tm('rename-session', '-t', 'current-session', 'renamed-session');
    const renamed = Bun.spawnSync(
      [process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'), 'list', '--json'],
      { env },
    );
    expect(renamed.exitCode).toBe(0);
    const agent = JSON.parse(renamed.stdout.toString()).agents.find((row: { pane: string }) => row.pane === pane);
    expect(agent.agentType).toBe('codex');
    expect(agent.session).toBe('renamed-session');
    expect(agent.label).toBe('Current agent');
  } finally {
    close();
  }
}, 15000);
