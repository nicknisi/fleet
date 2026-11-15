import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateTmux } from './private-tmux.ts';
import { refreshStates, verifyPaneState } from '../src/state/refresh.ts';
import { readAllStatusDirs } from '../src/state/hooks.ts';
import { AgentStatus } from '../src/state/types.ts';
import { listPanesResult } from '../src/tmux/sessions.ts';

test('scraped correction updates the selected hook instead of promoting a losing directory', async () => {
  const { root, tm, startAgent, waitFor, close } = privateTmux('fleet-correct-');
  const previous = process.env.TMUX;
  try {
    startAgent(100, 35, "import time\nprint('Do you want to proceed? [y/n]',flush=True)\ntime.sleep(90)");
    await waitFor(() => tm('capture-pane', '-p', '-t', 'agent').includes('[y/n]'));
    const server = Number(tm('display-message', '-p', '#{pid}'));
    const pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
    process.env.TMUX = `${join(root, 'tmux.sock')},${server},0`;
    const dirs = [
      { name: 'claude', statusDir: join(root, 'loser') },
      { name: 'codex', statusDir: join(root, 'winner') },
    ];
    const files = dirs.map((dir) => {
      mkdirSync(dir.statusDir);
      return join(dir.statusDir, `${pane.slice(1)}.status`);
    });
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < files.length; i++)
      writeFileSync(
        files[i]!,
        JSON.stringify({
          pane,
          session: 'agent',
          state: 'working',
          tool: 'fixture',
          tmux_pid: server,
          ts: now - (i === 0 ? 100 : 1),
          name: i === 0 ? 'Old agent' : 'Current agent',
        }),
      );
    const before = readFileSync(files[0]!, 'utf8');
    const state = refreshStates(dirs, { panesResult: listPanesResult(), hookStatuses: readAllStatusDirs(dirs) }).find(
      (row) => row.paneId === pane,
    )!;
    expect(state.agentType).toBe('codex');
    // A cached working row is corrected after a native permission appears.
    state.status = AgentStatus.BUSY;
    verifyPaneState(state, dirs);
    expect(readFileSync(files[0]!, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(files[1]!, 'utf8')).state).toBe('permit');
    const after = refreshStates(dirs, { panesResult: listPanesResult(), hookStatuses: readAllStatusDirs(dirs) }).find(
      (row) => row.paneId === pane,
    )!;
    expect(after.agentType).toBe('codex');
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
    close();
  }
}, 15000);

test('correction compares the scrape with a winner published after the displayed row', async () => {
  const { root, tm, startAgent, waitFor, close } = privateTmux('fleet-correct-drift-');
  const previous = process.env.TMUX;
  try {
    startAgent(100, 35, "import time\nprint('esc to interrupt',flush=True)\ntime.sleep(90)");
    await waitFor(() => tm('capture-pane', '-p', '-t', 'agent').includes('esc to interrupt'));
    const server = Number(tm('display-message', '-p', '#{pid}'));
    const pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
    process.env.TMUX = `${join(root, 'tmux.sock')},${server},0`;
    const dirs = ['old', 'new'].map((name) => ({ name: 'codex', statusDir: join(root, name) }));
    for (const dir of dirs) mkdirSync(dir.statusDir);
    const files = dirs.map((dir) => join(dir.statusDir, `${pane.slice(1)}.status`));
    const now = Math.floor(Date.now() / 1000);
    const hook = {
      pane,
      session: 'agent',
      state: 'working',
      tool: '',
      name: 'Same agent',
      ts: now - 10,
      tmux_pid: server,
    };
    writeFileSync(files[0]!, JSON.stringify(hook));
    const state = refreshStates(dirs, { panesResult: listPanesResult(), hookStatuses: readAllStatusDirs(dirs) }).find(
      (row) => row.paneId === pane,
    )!;
    state.status = AgentStatus.BUSY;
    const before = readFileSync(files[0]!, 'utf8');
    // Another status directory becomes the winner after this row was drawn.
    writeFileSync(files[1]!, JSON.stringify({ ...hook, state: 'permit', ts: now - 1 }));
    verifyPaneState(state, dirs);
    expect(readFileSync(files[0]!, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(files[1]!, 'utf8')).state).toBe('working');
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
    close();
  }
}, 15000);
