import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStatus, type AgentState } from '../state/types.ts';
import {
  buildInjectCommands,
  buildRemoveCommands,
  buildRollupEnableCommands,
  STATUS_ROW1_FORMAT,
  WINDOW_STATUS_FORMAT,
  WINDOW_STATUS_CURRENT_FORMAT,
  emitWindowColors,
} from './statusline.ts';

describe('emitWindowColors', () => {
  let work: string;
  let stub: string;
  let oldPath: string | undefined;
  let oldTmux: string | undefined;
  const state: AgentState = {
    paneId: '%1',
    paneNum: 1,
    session: 'test',
    window: 'main',
    windowId: '@1',
    claudeName: null,
    customName: null,
    status: AgentStatus.PERMIT,
    tool: null,
    project: '/tmp/test',
    branch: null,
    ports: [],
    ts: 0,
    agentType: 'claude',
  };
  beforeEach(() => {
    oldPath = process.env.PATH;
    oldTmux = process.env.TMUX;
    work = mkdtempSync(join(tmpdir(), 'fleet-colors-'));
    stub = join(work, 'tmux');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$0.log"\n[ ! -e "$0.fail" ]\n', { mode: 0o755 });
    writeFileSync(`${stub}.log`, '');
    process.env.PATH = `${work}:${oldPath}`;
    process.env.TMUX = `${work}/socket,1,0`;
  });
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    rmSync(work, { recursive: true, force: true });
  });
  const calls = () => readFileSync(`${stub}.log`, 'utf8').trim().split('\n').filter(Boolean);

  test('unchanged ticks skip tmux until the reconciliation interval', () => {
    for (let now = 0; now < 5_000; now += 500) emitWindowColors([state], now);
    expect(calls()).toHaveLength(1);
    emitWindowColors([state], 5_000);
    expect(calls()).toHaveLength(2);
  });

  test('clears attention immediately, even inside the interval', () => {
    emitWindowColors([state], 0);
    emitWindowColors([{ ...state, status: AgentStatus.BUSY }], 500);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toContain('set -w -u -t @1 @fleet_state');
    emitWindowColors([{ ...state, status: AgentStatus.BUSY }], 1_000);
    expect(calls()).toHaveLength(2);
  });

  test('failed writes retry and a different server is not deduplicated', () => {
    writeFileSync(`${stub}.fail`, '');
    emitWindowColors([state], 0);
    rmSync(`${stub}.fail`);
    emitWindowColors([state], 500);
    emitWindowColors([state], 1_000);
    expect(calls()).toHaveLength(2);
    process.env.TMUX = `${work}/other,2,0`;
    emitWindowColors([state], 1_500);
    expect(calls()).toHaveLength(3);
  });

  test('a partially failed batch invalidates the previous successful signature', () => {
    emitWindowColors([state], 0);
    writeFileSync(`${stub}.fail`, '');
    emitWindowColors(
      [
        { ...state, status: AgentStatus.BUSY },
        { ...state, paneId: '%2', windowId: '@2' },
      ],
      500,
    );
    rmSync(`${stub}.fail`);
    // The first command in the failed batch may have cleared @1's tint.
    // Restoring the old desired state must not be mistaken for a no-op.
    emitWindowColors([state], 1_000);
    expect(calls()).toHaveLength(3);
  });

  test('empty state and backwards time invalidate the last successful batch', () => {
    emitWindowColors([state], 10_000);
    emitWindowColors([], 10_100);
    emitWindowColors([state], 10_200);
    expect(calls()).toHaveLength(2);
    emitWindowColors([state], 0);
    expect(calls()).toHaveLength(3);
  });
});

describe('STATUS_ROW1_FORMAT', () => {
  // isStatusLineInjected compares a live `show -gqv status-format[1]` against
  // this constant, so the value inject writes has to come from the same place.
  test('is the exact value buildInjectCommands writes to status-format[1]', () => {
    const row1 = buildInjectCommands().find((c) => c[3] === 'status-format[1]');
    expect(row1).toBeDefined();
    expect(row1![4]).toBe(STATUS_ROW1_FORMAT);
  });
});

describe('buildInjectCommands', () => {
  test('returns status-2, status-format[1], both mouse binds, and the focus hook', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toHaveLength(6);
    expect(cmds[0]).toEqual(['tmux', 'set', '-g', 'status', '2']);
    expect(cmds[1]).toEqual(['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)']);
    expect(cmds[2]![0]).toBe('tmux');
    expect(cmds[2]![1]).toBe('bind');
    expect(cmds[2]).toContain('MouseDown1Status');
    expect(cmds[3]![1]).toBe('bind');
    expect(cmds[3]).toContain('MouseDown3Status');
  });

  test('registers a pane-focus-in hook that acks the focused pane', () => {
    const cmds = buildInjectCommands();
    // focus-events must be on for pane-focus-in to fire at all.
    expect(cmds).toContainEqual(['tmux', 'set', '-g', 'focus-events', 'on']);
    // The hook itself: reaching a pane by any route clears its ready chip.
    const hook = cmds.find((c) => c[1] === 'set-hook');
    expect(hook).toBeDefined();
    // Indexed so it coexists with a user's own pane-focus-in hook at [0].
    expect(hook).toContain('pane-focus-in[99]');
    const action = hook!.find((a) => a.includes('fleet ack'));
    expect(action).toBeDefined();
    expect(action).toContain('#{pane_id}');
    // Backgrounded so a pane switch never waits on fleet starting up.
    expect(action).toContain('-b');
  });

  test('all commands invoke tmux', () => {
    const cmds = buildInjectCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('does not touch window-status-format — the rollup format lives in the conf, not the inject', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toHaveLength(6);
    expect(cmds.some((c) => c.some((a) => a.includes('window-status-format')))).toBe(false);
    expect(cmds.some((c) => c.some((a) => a.includes('window-status-current-format')))).toBe(false);
    expect(cmds.some((c) => c.some((a) => a.includes('@fleet_rollup')))).toBe(false);
  });

  test('bind uses MouseDown1Status with if-shell guard for row 1 only', () => {
    const cmds = buildInjectCommands();
    const bindCmd = cmds.find((c) => c[1] === 'bind' && c.includes('MouseDown1Status'));
    expect(bindCmd).toBeDefined();
    expect(bindCmd).toContain('MouseDown1Status');
    expect(bindCmd).toContain('if-shell');
    const condArg = bindCmd!.find((a) => a.includes('mouse_status_line'));
    expect(condArg).toBeDefined();
    const trueArg = bindCmd!.find((a) => a.includes('fleet switch'));
    expect(trueArg).toBeDefined();
    const falseArg = bindCmd!.find((a) => a.includes('select-window'));
    expect(falseArg).toBeDefined();
  });

  test('left-click guard fires on any non-empty range so the clear chip routes too', () => {
    const cmds = buildInjectCommands();
    const bindCmd = cmds.find((c) => c[1] === 'bind' && c.includes('MouseDown1Status'));
    const condArg = bindCmd!.find((a) => a.includes('mouse_status_line'));
    // Must not be restricted to pane-id ranges (%*) anymore.
    expect(condArg).not.toContain('%*');
    expect(condArg).toContain('mouse_status_range');
  });

  test('binds MouseDown3Status (right-click) to fleet ack with the same guard', () => {
    const cmds = buildInjectCommands();
    const ackBind = cmds.find((c) => c[1] === 'bind' && c.includes('MouseDown3Status'));
    expect(ackBind).toBeDefined();
    expect(ackBind).toContain('if-shell');
    const condArg = ackBind!.find((a) => a.includes('mouse_status_line'));
    expect(condArg).toBeDefined();
    const trueArg = ackBind!.find((a) => a.includes('fleet ack'));
    expect(trueArg).toBeDefined();
  });
});

describe('buildRemoveCommands', () => {
  test('unsets status-format[1], resets status, unbinds both mouse buttons, removes the focus hook, and reverts the rollup', () => {
    const cmds = buildRemoveCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '-u', 'status-format[1]'],
      ['tmux', 'set', '-g', 'status', 'on'],
      ['tmux', 'unbind', '-T', 'root', 'MouseDown1Status'],
      ['tmux', 'unbind', '-T', 'root', 'MouseDown3Status'],
      ['tmux', 'set-hook', '-gu', 'pane-focus-in[99]'],
      ['tmux', 'set', '-g', '-u', 'window-status-format'],
      ['tmux', 'set', '-g', '-u', 'window-status-current-format'],
      ['tmux', 'set', '-g', '-u', '@fleet_rollup'],
    ]);
  });

  test('removes only our indexed focus hook, leaving focus-events untouched', () => {
    const cmds = buildRemoveCommands();
    const unsetHook = cmds.find((c) => c[1] === 'set-hook');
    expect(unsetHook).toEqual(['tmux', 'set-hook', '-gu', 'pane-focus-in[99]']);
    // We never set focus-events back off — can't know the user's prior value,
    // and leaving it on is harmless.
    expect(cmds.some((c) => c.includes('focus-events'))).toBe(false);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildRemoveCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('unbinds both MouseDown1Status and MouseDown3Status', () => {
    const cmds = buildRemoveCommands();
    const unbinds = cmds.filter((c) => c[1] === 'unbind');
    expect(unbinds.some((c) => c.includes('MouseDown1Status'))).toBe(true);
    expect(unbinds.some((c) => c.includes('MouseDown3Status'))).toBe(true);
  });
});

describe('buildRollupEnableCommands', () => {
  test('sets the gate option and both window-status formats from the shared constants', () => {
    const cmds = buildRollupEnableCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '@fleet_rollup', '1'],
      ['tmux', 'set', '-g', 'window-status-format', WINDOW_STATUS_FORMAT],
      ['tmux', 'set', '-g', 'window-status-current-format', WINDOW_STATUS_CURRENT_FORMAT],
    ]);
  });

  test('the format constants tint only when @fleet_state is present', () => {
    // Conditional expansion: colored branch reads #{@fleet_state}, empty branch
    // leaves the entry untinted.
    expect(WINDOW_STATUS_FORMAT).toContain('#{?#{@fleet_state},#[fg=#{@fleet_state}],}');
    expect(WINDOW_STATUS_CURRENT_FORMAT).toContain('#{?#{@fleet_state},#[fg=#{@fleet_state}],}');
    // Current-window format keeps the bold emphasis.
    expect(WINDOW_STATUS_CURRENT_FORMAT).toContain('#[bold]');
  });

  test('all commands invoke tmux', () => {
    for (const cmd of buildRollupEnableCommands()) {
      expect(cmd[0]).toBe('tmux');
    }
  });
});
