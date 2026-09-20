// Real TUI lifecycle on a private tmux server. No user panes/config touched.
// Run: bun test ./e2e/sidebar.e2e.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const available = ['tmux', 'python3'].every(
  (bin) => Bun.spawnSync(['which', bin], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0,
);
const suite = available ? describe : describe.skip;
const entry = resolve(import.meta.dir, '../index.ts');
const attachments: Bun.Subprocess[] = [];
let root = '';
let socket = '';
let config = '';
let source = '';
let target = '';
let client = '';
let sidebar = '';
let sidebarPid = '';
let statusDir = '';

function tm(...args: string[]): string {
  const proc = Bun.spawnSync(['tmux', '-S', socket, '-f', '/dev/null', ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: config, TMPDIR: root, TERM: 'xterm-256color' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}
const screen = () => tm('capture-pane', '-p', '-S', '-100', '-t', sidebar);
const location = (pane: string) => tm('display-message', '-p', '-t', pane, '#{window_id}');
async function until(check: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await Bun.sleep(50);
  }
  if (!check())
    throw new Error(
      `Timed out; panes: ${tm('list-panes', '-a', '-F', '#{pane_id} #{pane_current_command} #{pane_dead} #{pane_start_command}')}\nclients: ${tm('list-clients', '-F', '#{client_name} #{client_flags}')}\nscreen: ${sidebar ? screen() : '(no sidebar)'}`,
    );
}
function attach(session: string): void {
  // stdlib PTY provides a real (non-control) tmux client even in headless CI.
  const launcher = `import os, pty, sys, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.execvp('tmux', ['tmux', '-S', sys.argv[1], 'attach-session', '-t', sys.argv[2]])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
while True:
    try:
        if not os.read(fd, 65536): break
    except OSError: break
os.waitpid(pid, 0)
`;
  attachments.push(
    Bun.spawn(['python3', '-c', launcher, socket, session], {
      env: { ...process.env, TMUX: '', TERM: 'xterm-256color' },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  );
}
function openSidebar(from: string): void {
  const pid = tm('display-message', '-p', '#{pid}');
  const command = process.env.FLEET_TEST_BIN ? [process.env.FLEET_TEST_BIN] : [process.execPath, entry];
  const proc = Bun.spawnSync([...command, 'sidebar', '--from', from, '--client', client], {
    env: { ...process.env, TMUX: `${socket},${pid},0`, XDG_CONFIG_HOME: config, TMPDIR: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(proc.exitCode).toBe(0);
}

suite('persistent sidebar in real tmux', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'fleet-sidebar-'));
    socket = join(root, 'tmux.sock');
    config = join(root, 'config');
    statusDir = join(root, 'status');
    mkdirSync(join(config, 'fleet'), { recursive: true });
    mkdirSync(statusDir);
    writeFileSync(join(config, 'fleet', 'agents.json'), JSON.stringify({ agents: [{ name: 'claude', statusDir }] }));
    source = tm(
      'new-session',
      '-d',
      '-s',
      'sidebar-test',
      '-n',
      'source',
      '-x',
      '140',
      '-y',
      '40',
      '-P',
      '-F',
      '#{pane_id}',
      'sleep 300',
    );
    tm('set', '-g', '@fleet_discover', 'off');
    tm('set', '-g', 'remain-on-exit', 'on');
    target = tm('new-window', '-d', '-t', 'sidebar-test', '-n', 'destination', '-P', '-F', '#{pane_id}', 'sleep 300');
    for (const [pane, state] of [
      [source, 'completed'],
      [target, 'permit'],
    ]) {
      writeFileSync(
        join(statusDir, `${pane!.slice(1)}.status`),
        JSON.stringify({
          pane,
          state,
          session: 'sidebar-test',
          tool: '',
          ts: Math.floor(Date.now() / 1000),
          tmux_pid: 0,
        }),
      );
    }
    attach('sidebar-test');
    await until(() => tm('list-clients', '-F', '#{client_name}').length > 0);
    client = tm('list-clients', '-F', '#{client_name}').split('\n')[0]!;
    openSidebar(source);
    await until(() => {
      sidebar = tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}');
      return sidebar.length > 0 && screen().includes('need you');
    });
    sidebarPid = tm('display-message', '-p', '-t', sidebar, '#{pane_pid}');
    tm('set', '-g', 'remain-on-exit', 'off');
  }, 20_000);

  afterAll(async () => {
    if (socket) Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
    for (const process of attachments) {
      process.kill();
      await process.exited;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('Enter jumps to the exact agent, keeps the same TUI and preserves its filter', async () => {
    tm('send-keys', '-t', sidebar, '-l', '/destination');
    await until(() => screen().includes('/destination'));
    tm('send-keys', '-t', sidebar, 'Enter');
    await until(() => location(sidebar) === location(target));
    expect(tm('list-clients', '-F', '#{client_name}\t#{pane_id}')).toContain(`${client}\t${target}`);
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
    expect(screen()).toContain('/destination');
  });

  test('native window navigation carries the existing sidebar and resized width', async () => {
    tm('resize-pane', '-t', sidebar, '-x', '39');
    tm('select-window', '-t', source);
    await until(() => location(sidebar) === location(source));
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_width}')).toBe('39');
    expect(screen()).toContain('/destination');
    expect(tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}')).toBe(sidebar);
  });

  test('another real client cannot drag the sidebar away from its owner', async () => {
    tm('new-session', '-d', '-s', 'other-client', 'sleep 300');
    const other = tm('new-window', '-d', '-t', 'other-client', '-P', '-F', '#{pane_id}', 'sleep 300');
    attach('other-client');
    await until(
      () =>
        tm('list-clients', '-F', '#{client_name}\t#{client_flags}')
          .split('\n')
          .filter((l) => !l.includes('control-mode')).length === 2,
    );
    tm('select-window', '-t', other);
    await Bun.sleep(1100);
    expect(location(sidebar)).toBe(location(source));
  });

  test('the owner can change sessions without restarting or moving another client', async () => {
    const another = tm('new-session', '-d', '-s', 'owner-other', '-P', '-F', '#{pane_id}', 'sleep 300');
    tm('switch-client', '-c', client, '-t', another);
    await until(() => location(sidebar) === location(another));
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
    expect(tm('list-clients', '-F', '#{client_session}')).toContain('other-client');
    tm('switch-client', '-c', client, '-t', source);
    await until(() => location(sidebar) === location(source));
  });

  test('rapid window switching settles on the latest destination without duplicate scanners', async () => {
    const windows: string[] = [];
    for (let i = 0; i < 10; i++)
      windows.push(tm('new-window', '-d', '-t', 'sidebar-test', '-P', '-F', '#{pane_id}', 'sleep 300'));
    for (const pane of windows) tm('switch-client', '-c', client, '-t', pane);
    await until(() => location(sidebar) === location(windows.at(-1)!));
    expect(tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}')).toBe(sidebar);
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
    tm('switch-client', '-c', client, '-t', source);
    await until(() => location(sidebar) === location(source));
  });

  test('a zoomed destination stays zoomed; sidebar follows when it is unzoomed', async () => {
    const split = tm('split-window', '-d', '-h', '-t', target, '-P', '-F', '#{pane_id}', 'sleep 300');
    tm('resize-pane', '-Z', '-t', target);
    tm('switch-client', '-c', client, '-t', target);
    await Bun.sleep(650);
    expect(tm('display-message', '-p', '-t', target, '#{window_zoomed_flag}')).toBe('1');
    tm('resize-pane', '-Z', '-t', target);
    await until(() => location(sidebar) === location(target));
    tm('kill-pane', '-t', split);
    tm('switch-client', '-c', client, '-t', source);
    await until(() => location(sidebar) === location(source));
  });

  test('leaving a zoomed source restores its zoom after the sidebar moves away', async () => {
    const split = tm('split-window', '-d', '-h', '-t', source, '-P', '-F', '#{pane_id}', 'sleep 300');
    tm('resize-pane', '-Z', '-t', source);
    tm('switch-client', '-c', client, '-t', target);
    await until(() => location(sidebar) === location(target));
    expect(tm('display-message', '-p', '-t', source, '#{window_zoomed_flag}')).toBe('1');
    tm('resize-pane', '-Z', '-t', source);
    tm('kill-pane', '-t', split);
    tm('switch-client', '-c', client, '-t', source);
    await until(() => location(sidebar) === location(source));
  });

  test('detach parks the sidebar; reattach reclaims the same process', async () => {
    tm('detach-client', '-t', client);
    await Bun.sleep(650);
    expect(tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}')).toBe(sidebar);
    attach('sidebar-test');
    await until(() =>
      tm('list-clients', '-F', '#{client_session}\t#{client_name}\t#{client_flags}')
        .split('\n')
        .some((l) => l.startsWith('sidebar-test\t') && !l.includes('control-mode')),
    );
    const row = tm('list-clients', '-F', '#{client_session}\t#{client_name}\t#{client_pid}\t#{client_flags}')
      .split('\n')
      .find((l) => l.startsWith('sidebar-test\t') && !l.includes('control-mode'))!
      .split('\t');
    client = row[1]!;
    await until(() => tm('show', '-pqv', '-t', sidebar, '@fleet_sidebar_client') === row[2]);
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
  });

  test('repeated x cannot delete the selected agent', async () => {
    tm('send-keys', '-t', sidebar, '-l', '/source');
    tm('send-keys', '-t', sidebar, 'Enter');
    await until(() => screen().includes('/source') && !screen().includes('/source█'));
    tm('send-keys', '-t', sidebar, 'x', 'x');
    await Bun.sleep(300);
    expect(tm('list-panes', '-a', '-F', '#{pane_id}').split('\n')).toContain(source);
  });

  test('a newly blocked send retains its draft and never types into another pane', async () => {
    tm('send-keys', '-t', sidebar, 's');
    await until(() => screen().includes(`Send to ${source}: sidebar-test`));
    tm('send-keys', '-t', sidebar, '-l', 'kept-draft');
    writeFileSync(
      join(statusDir, `${source.slice(1)}.status`),
      JSON.stringify({
        pane: source,
        state: 'question',
        session: 'sidebar-test',
        ts: Math.floor(Date.now() / 1000),
        tool: '',
      }),
    );
    tm('send-keys', '-t', sidebar, 'Enter');
    await until(() => screen().includes('Draft kept'));
    expect(screen()).toContain('kept-draft');
    expect(tm('capture-pane', '-p', '-t', source)).not.toContain('kept-draft');
    expect(tm('capture-pane', '-p', '-t', target)).not.toContain('kept-draft');
    tm('send-keys', '-t', sidebar, 'Escape');
    writeFileSync(
      join(statusDir, `${source.slice(1)}.status`),
      JSON.stringify({
        pane: source,
        state: 'idle',
        session: 'sidebar-test',
        ts: Math.floor(Date.now() / 1000),
        tool: '',
      }),
    );
  });

  test('reopening focuses instead of restarting; q closes only the sidebar', async () => {
    openSidebar(source);
    expect(tm('display-message', '-p', '-t', sidebar, '#{pane_pid}')).toBe(sidebarPid);
    expect(tm('list-clients', '-F', '#{client_name}\t#{pane_id}')).toContain(`${client}\t${sidebar}`);
    tm('send-keys', '-t', sidebar, 'Escape');
    await until(() => !screen().includes('/source'));
    tm('send-keys', '-t', sidebar, 'q');
    await until(() => tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}') === '');
    expect(tm('list-panes', '-a', '-F', '#{pane_id}').split('\n')).toContain(source);
    expect(tm('list-panes', '-a', '-F', '#{pane_id}').split('\n')).toContain(target);
  });

  test('Ctrl-C exits immediately even while an action error is awaiting dismissal', async () => {
    openSidebar(source);
    sidebar = tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}');
    await until(() => screen().includes('need you'));
    tm('send-keys', '-t', sidebar, '-l', '/destination');
    tm('send-keys', '-t', sidebar, 'Enter');
    await until(() => screen().includes('/destination') && !screen().includes('/destination█'));
    tm('send-keys', '-t', sidebar, 's');
    await until(() => screen().includes('Agent has a permission prompt'));
    tm('send-keys', '-t', sidebar, 'C-c');
    await until(() => tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}') === '');
    expect(tm('list-panes', '-a', '-F', '#{pane_id}').split('\n')).toContain(target);
  }, 15_000);
});
