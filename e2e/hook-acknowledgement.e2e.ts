import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACK_ALL_RANGE } from '../src/state/types.ts';
import { privateTmux } from './private-tmux.ts';

test.each(['pane', 'all'])(
  'acknowledging %s changes only the selected live hook',
  (scope) => {
    const { root, tm, close } = privateTmux('fleet-ack-owner-');
    try {
      tm('new-session', '-d', '-s', 'agent', 'sleep', '60');
      const pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
      const server = Number(tm('display-message', '-p', '#{pid}'));
      const dirs = [
        { name: 'claude', statusDir: join(root, 'loser') },
        { name: 'codex', statusDir: join(root, 'winner') },
      ];
      const files = dirs.map((dir) => {
        mkdirSync(dir.statusDir);
        return join(dir.statusDir, `${pane.slice(1)}.status`);
      });
      writeFileSync(join(root, 'config/fleet/agents.json'), JSON.stringify({ agents: dirs }));
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < files.length; i++)
        writeFileSync(
          files[i]!,
          JSON.stringify({
            pane,
            session: 'agent',
            state: 'completed',
            tool: '',
            name: i === 0 ? 'Old agent' : 'Current agent',
            ts: now - (i === 0 ? 100 : 1),
            tmux_pid: server,
          }),
        );
      const before = readFileSync(files[0]!, 'utf8');
      const env = {
        ...process.env,
        HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_CACHE_HOME: join(root, 'cache'),
        TMUX: `${join(root, 'tmux.sock')},${server},0`,
      };
      const result = Bun.spawnSync(
        [
          process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'),
          'ack',
          scope === 'all' ? ACK_ALL_RANGE : pane,
        ],
        { env },
      );
      expect(result.exitCode).toBe(0);
      expect(readFileSync(files[0]!, 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(files[1]!, 'utf8')).state).toBe('idle');
    } finally {
      close();
    }
  },
  15000,
);
