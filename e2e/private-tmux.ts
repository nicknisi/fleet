// A private tmux server with one scripted agent pane and a compiled Fleet
// monitor. It never touches the developer's server or real conversations.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function privateTmux(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const socket = join(root, 'tmux.sock');
  const env = {
    ...process.env,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    FLEET_THEME: 'dark',
    TMUX: '',
  };
  const tm = (...args: string[]) => {
    const result = Bun.spawnSync(['tmux', '-u', '-f', '/dev/null', '-S', socket, ...args], { env });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trimEnd();
  };
  const has = (session: string) =>
    Bun.spawnSync(['tmux', '-S', socket, 'has-session', '-t', session], { env }).exitCode === 0;
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (check()) return;
      await Bun.sleep(30);
    }
    // Not tm(): it throws when no monitor session exists, hiding the timeout.
    const screen = Bun.spawnSync(['tmux', '-S', socket, 'capture-pane', '-p', '-t', 'monitor'], { env });
    throw new Error('Timed out waiting for fixture\n' + screen.stdout.toString());
  };
  mkdirSync(join(root, 'config/fleet'), { recursive: true });
  writeFileSync(join(root, 'config/fleet/agents.json'), '{"agents":[]}');
  const startAgent = (width: number, height: number, script: string, extraEnv: Record<string, string> = {}) => {
    writeFileSync(join(root, 'agent.py'), script);
    tm(
      'new-session',
      '-d',
      '-s',
      'agent',
      '-x',
      String(width),
      '-y',
      String(height),
      ...(Object.keys(extraEnv).length
        ? ['/usr/bin/env', ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`)]
        : []),
      'python3',
      '-u',
      join(root, 'agent.py'),
    );
    env.TMUX = `${socket},${tm('display-message', '-p', '#{pid}')},0`;
  };
  const startMonitor = (extraEnv: Record<string, string> = {}, args: string[] = []) =>
    tm(
      'new-session',
      '-d',
      '-s',
      'monitor',
      '-x',
      '192',
      '-y',
      '57',
      '/usr/bin/env',
      ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
      process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'),
      ...args,
    );
  const close = () => {
    Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { env });
    rmSync(root, { recursive: true, force: true });
  };
  return { root, tm, has, waitFor, startAgent, startMonitor, close };
}
