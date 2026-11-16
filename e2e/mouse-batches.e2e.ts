import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateTmux } from './private-tmux.ts';

test('batched divider press, movement and release complete one drag', async () => {
  const { root, tm, startAgent, startMonitor, waitFor, close } = privateTmux('fleet-mouse-');
  try {
    startAgent(100, 35, "import time\nprint('fixture ready',flush=True)\ntime.sleep(90)");
    const status = join(root, 'status');
    mkdirSync(status);
    const pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
    writeFileSync(
      join(root, 'config/fleet/agents.json'),
      JSON.stringify({ agents: [{ name: 'codex', statusDir: status }] }),
    );
    writeFileSync(
      join(status, `${pane.slice(1)}.status`),
      JSON.stringify({
        pane,
        session: 'agent',
        state: 'idle',
        tool: '',
        ts: Math.floor(Date.now() / 1000),
        tmux_pid: Number(tm('display-message', '-p', '#{pid}')),
      }),
    );
    startMonitor({}, ['--preview']);
    const screen = () => tm('capture-pane', '-p', '-t', 'monitor');
    // Read the divider from real terminal output, then send one input batch.
    const divider = () =>
      screen()
        .split('\n')
        .map((line) => line.indexOf('│'))
        .find((col) => col > 0) ?? -1;
    await waitFor(() => divider() > 0);
    const before = divider();
    const x = before + 1;
    const destination = 90;
    tm('send-keys', '-t', 'monitor', '-l', `\x1b[<0;${x};10M\x1b[<32;${destination};10M\x1b[<0;${destination};10m`);
    await waitFor(() => divider() === destination);
    // A later motion must not resize again after the batched release.
    tm('send-keys', '-t', 'monitor', '-l', '\x1b[<32;110;10M');
    await Bun.sleep(300);
    expect(divider()).toBe(destination);
  } finally {
    close();
  }
}, 15000);

test('a mouse batch dismisses a vanished-target error without acknowledging the fallback row', async () => {
  const { root, tm, startAgent, startMonitor, waitFor, close } = privateTmux('fleet-mouse-error-');
  try {
    startAgent(100, 35, "import time\nprint('target ready',flush=True)\ntime.sleep(90)");
    const status = join(root, 'status');
    mkdirSync(status);
    const pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
    const fallback = tm('new-session', '-d', '-s', 'fallback', '-P', '-F', '#{pane_id}', 'sleep', '90');
    const server = Number(tm('display-message', '-p', '#{pid}'));
    writeFileSync(
      join(root, 'config/fleet/agents.json'),
      JSON.stringify({ agents: [{ name: 'codex', statusDir: status }] }),
    );
    for (const [id, session, state, name] of [
      [pane, 'agent', 'permit', 'Target'],
      [fallback, 'fallback', 'completed', 'Fallback agent'],
    ])
      writeFileSync(
        join(status, `${id!.slice(1)}.status`),
        JSON.stringify({
          pane: id,
          session,
          state,
          name,
          tool: '',
          ts: Math.floor(Date.now() / 1000),
          tmux_pid: server,
        }),
      );
    startMonitor({}, ['--preview']);
    const screen = () => tm('capture-pane', '-p', '-t', 'monitor');
    await waitFor(() => screen().includes('target ready'));
    tm('send-keys', '-t', 'monitor', 'i');
    await waitFor(() => screen().includes('● LIVE'));
    tm('kill-session', '-t', 'agent');
    await waitFor(() => screen().includes('disappeared') && !screen().includes('● LIVE'));
    const path = join(status, `${fallback.slice(1)}.status`);
    const before = readFileSync(path, 'utf8');
    const row =
      screen()
        .split('\n')
        .findIndex((line) => line.includes('Fallback agent')) + 1;
    expect(row).toBeGreaterThan(0);
    tm('send-keys', '-t', 'monitor', '-l', `\x1b[<35;5;${row}M\x1b[<0;5;${row}M`);
    await waitFor(() => !screen().includes('disappeared'));
    await Bun.sleep(250);
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    close();
  }
}, 15000);
