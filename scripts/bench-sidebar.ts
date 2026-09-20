// Isolated, repeatable sidebar benchmark. Counts Fleet's tmux subprocesses,
// not the controller's. Latencies include controller round trips; compare runs
// on the same host/load. Requires tmux + Python's stdlib PTY, like sidebar E2E.
// bun scripts/bench-sidebar.ts /absolute/path/to/fleet [pane-count]
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'dist/fleet');
const count = Number(process.argv[3] ?? 12);
if (!Number.isInteger(count) || count < 2 || count > 100)
  throw new Error('pane-count must be an integer from 2 to 100');
const realTmux = Bun.spawnSync(['which', 'tmux']).stdout.toString().trim();
const root = mkdtempSync(join(tmpdir(), 'fleet-bench-'));
const socket = join(root, 'tmux.sock');
const config = join(root, 'config');
const statusDir = join(root, 'status');
const log = join(root, 'tmux.log');
const binDir = join(root, 'bin');
for (const path of [join(config, 'fleet'), statusDir, binDir]) mkdirSync(path, { recursive: true });
writeFileSync(join(config, 'fleet', 'agents.json'), JSON.stringify({ agents: [{ name: 'claude', statusDir }] }));
writeFileSync(log, '');
writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realTmux}' "$@"\n`, {
  mode: 0o755,
});
const env = {
  ...process.env,
  TMUX: '',
  TMPDIR: root,
  XDG_CONFIG_HOME: config,
  PATH: `${binDir}:${process.env.PATH}`,
  TERM: 'xterm-256color',
};
const tm = async (...args: string[]) => {
  const p = Bun.spawn([realTmux, '-S', socket, '-f', '/dev/null', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err);
  return out.trim();
};
const sleep = (ms: number) => Bun.sleep(ms);
const until = async (check: () => Promise<boolean>, label: string = 'follow') => {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > 10000) throw new Error(`benchmark timed out: ${label}`);
    await sleep(10);
  }
};
const counts = () => {
  const calls: Record<string, number> = {};
  for (const line of readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)) {
    const cmd = line.split(' ')[0]!;
    calls[cmd] = (calls[cmd] ?? 0) + 1;
  }
  return calls;
};
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]!),
    p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
  };
};
let attached: Bun.Subprocess | undefined;
try {
  const panes: string[] = [];
  panes.push(await tm('new-session', '-d', '-s', 'bench', '-x', '180', '-y', '40', '-P', '-F', '#{pane_id}', 'cat'));
  for (let i = 1; i < count; i++)
    panes.push(await tm('new-window', '-d', '-t', 'bench', '-n', `agent-${i}`, '-P', '-F', '#{pane_id}', 'cat'));
  await tm('set', '-g', '@fleet_discover', 'off');
  const writeStatus = (pane: string, state: string) =>
    writeFileSync(
      join(statusDir, `${pane.slice(1)}.status`),
      JSON.stringify({
        pane,
        state,
        session: 'bench',
        name: `agent-${panes.indexOf(pane)}`,
        tool: '',
        ts: Math.floor(Date.now() / 1000),
      }),
    );
  for (const p of panes) writeStatus(p, 'idle');
  attached = Bun.spawn(
    [
      'python3',
      '-c',
      `import os,pty,sys,fcntl,termios,struct
pid,fd=pty.fork()
if pid==0: os.execvp(sys.argv[1],[sys.argv[1],'-S',sys.argv[2],'attach-session','-t','bench'])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,180,0,0))
while True:
 try:
  if not os.read(fd,65536): break
 except OSError: break
os.waitpid(pid,0)
`,
      realTmux,
      socket,
    ],
    { env, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
  );
  await until(async () => (await tm('list-clients', '-F', '#{client_name}')).length > 0, 'attach');
  const client = await tm('list-clients', '-F', '#{client_name}');
  const pid = await tm('display-message', '-p', '#{pid}');
  const open = Bun.spawn([binary, 'sidebar', '--from', panes[0]!, '--client', client], {
    env: { ...env, TMUX: `${socket},${pid},0` },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await open.exited) !== 0) throw new Error('sidebar failed');
  const sidebar = await tm('list-panes', '-a', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}');
  await until(async () => (await tm('capture-pane', '-p', '-t', sidebar)).includes('idle'), 'startup');
  await sleep(600);
  writeFileSync(log, '');
  await sleep(1500);
  const quiet = counts();
  writeFileSync(log, '');
  for (let i = 0; i < 24; i++) {
    writeStatus(panes[0]!, 'idle');
    await sleep(30);
  }
  await sleep(300);
  const hookBurst = counts();
  const follows: number[] = [];
  for (let i = 0; i < 12; i++) {
    const p = panes[(i + 1) % panes.length]!;
    const destination = await tm('display-message', '-p', '-t', p, '#{window_id}');
    const start = performance.now();
    await tm('switch-client', '-c', client, '-t', p);
    await until(async () => (await tm('display-message', '-p', '-t', sidebar, '#{window_id}')) === destination);
    follows.push(performance.now() - start);
  }
  // Passthrough shows the tail of a taller target. Put the fixture's cursor
  // in that visible tail so echo timing measures rendering, not offscreen text.
  await tm('send-keys', '-t', panes[0]!, ...Array.from({ length: 40 }, () => 'Enter'));
  await sleep(100);
  await tm('resize-pane', '-t', sidebar, '-x', '100');
  await tm('select-pane', '-t', sidebar);
  await tm('send-keys', '-t', sidebar, '-l', '/agent-0');
  await tm('send-keys', '-t', sidebar, 'Enter');
  await sleep(600);
  await tm('select-pane', '-t', sidebar);
  await tm('send-keys', '-t', sidebar, 'p', 'i');
  await until(async () => (await tm('capture-pane', '-p', '-t', sidebar)).includes('LIVE'), 'passthrough');
  writeFileSync(log, '');
  await sleep(1500);
  const live = counts();
  const inputs: number[] = [];
  const echoes: number[] = [];
  for (let i = 0; i < 12; i++) {
    const text = `b${String(i).padStart(2, '0')} `;
    const start = performance.now();
    await tm('send-keys', '-t', sidebar, '-l', text);
    await until(
      async () => (await tm('capture-pane', '-p', '-t', panes[0]!)).replace(/\s/g, '').includes(text.trim()),
      `input ${i}`,
    );
    inputs.push(performance.now() - start);
    await until(async () => (await tm('capture-pane', '-p', '-t', sidebar)).includes(text.trim()), `preview echo ${i}`);
    echoes.push(performance.now() - start);
  }
  console.log(
    JSON.stringify(
      {
        binary,
        panes: count,
        controlMode: process.env.FLEET_CONTROL_MODE !== '0',
        quiet1500ms: quiet,
        hookBurst24: hookBurst,
        passthrough1500ms: live,
        follow: stats(follows),
        input: stats(inputs),
        previewEcho: stats(echoes),
      },
      null,
      2,
    ),
  );
} finally {
  await tm('kill-server').catch(() => {});
  if (attached) {
    attached.kill();
    await attached.exited;
  }
  rmSync(root, { recursive: true, force: true });
}
