// Keys read together with the key that opens a live view were meant for the
// agent and must not run as Fleet shortcuts. One tmux write reaches Fleet as a
// single read, as fast typing, SSH batching or a busy event loop can.
// Private tmux server; no user panes or config are touched.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '..', 'dist', 'fleet');
const available =
  existsSync(BIN) &&
  ['tmux', 'python3'].every(
    (bin) => Bun.spawnSync(['which', bin], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0,
  );
const run = available ? test : test.skip;

const AGENT = `import ctypes,signal
ctypes.CDLL(None).prctl(15,b"codex",0,0,0)
print('agent ready', flush=True)
signal.pause()
`;

const cases: Array<[string, string, string]> = [
  ['i then text starting with "xy"', 'ixy', '● LIVE'],
  ['i then q', 'iq', '● LIVE'],
];

for (const [name, keys, view] of cases) {
  run(
    `${name} in one read leaves the agent alive and shows the new view`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'fleet-coalesced-'));
      const socket = join(root, 'tmux.sock');
      const env = { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), TMUX: '' };
      const tm = (...args: string[]) => {
        const p = Bun.spawnSync(['tmux', '-S', socket, '-f', '/dev/null', ...args], { env });
        if (p.exitCode) throw new Error(p.stderr.toString());
        return p.stdout.toString().trimEnd();
      };
      const has = (session: string) =>
        Bun.spawnSync(['tmux', '-S', socket, 'has-session', '-t', session], { env }).exitCode === 0;
      try {
        mkdirSync(join(root, 'config', 'fleet'), { recursive: true });
        writeFileSync(join(root, 'config', 'fleet', 'agents.json'), '{"agents":[]}');
        writeFileSync(join(root, 'agent.py'), AGENT);
        tm('new-session', '-d', '-s', 'agent', '-x', '80', '-y', '24', 'python3', '-u', join(root, 'agent.py'));
        env.TMUX = `${socket},${tm('display-message', '-p', '#{pid}')},0`;
        const agentPid = tm('display-message', '-p', '-t', 'agent', '#{pane_pid}');
        tm('new-session', '-d', '-s', 'monitor', '-x', '192', '-y', '57', BIN);
        const until = Date.now() + 6000;
        while (Date.now() < until && !tm('capture-pane', '-p', '-t', 'monitor').includes('agent ready')) {
          await Bun.sleep(30);
        }
        expect(tm('capture-pane', '-p', '-t', 'monitor')).toContain('agent ready');
        tm('send-keys', '-t', 'monitor', '-l', keys);
        await Bun.sleep(800);
        expect(has('monitor')).toBe(true);
        expect(has('agent')).toBe(true);
        expect(tm('display-message', '-p', '-t', 'agent', '#{pane_pid}')).toBe(agentPid);
        expect(tm('capture-pane', '-p', '-t', 'monitor')).toContain(view);
      } finally {
        Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { env });
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
}
