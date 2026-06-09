import { describe, expect, test } from 'bun:test';
import { buildInjectCommands, buildRemoveCommands } from './statusline.ts';

describe('buildInjectCommands', () => {
  test('returns enable status-2, status-format[1], and both mouse bind commands', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toHaveLength(4);
    expect(cmds[0]).toEqual(['tmux', 'set', '-g', 'status', '2']);
    expect(cmds[1]).toEqual(['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)']);
    expect(cmds[2]![0]).toBe('tmux');
    expect(cmds[2]![1]).toBe('bind');
    expect(cmds[2]).toContain('MouseDown1Status');
    expect(cmds[3]![1]).toBe('bind');
    expect(cmds[3]).toContain('MouseDown3Status');
  });

  test('all commands invoke tmux', () => {
    const cmds = buildInjectCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
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
  test('unsets status-format[1], resets status, and unbinds both mouse buttons', () => {
    const cmds = buildRemoveCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '-u', 'status-format[1]'],
      ['tmux', 'set', '-g', 'status', 'on'],
      ['tmux', 'unbind', '-T', 'root', 'MouseDown1Status'],
      ['tmux', 'unbind', '-T', 'root', 'MouseDown3Status'],
    ]);
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
