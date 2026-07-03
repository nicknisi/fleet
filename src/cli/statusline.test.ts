import { describe, expect, test } from 'bun:test';
import {
  buildInjectCommands,
  buildRemoveCommands,
  buildRollupEnableCommands,
  WINDOW_STATUS_FORMAT,
  WINDOW_STATUS_CURRENT_FORMAT,
} from './statusline.ts';

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
