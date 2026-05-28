import { describe, expect, test } from 'bun:test';
import { buildInjectCommands, buildRemoveCommands } from './statusline.ts';

describe('buildInjectCommands', () => {
  test('returns enable status-2, status-format[1], and mouse bind commands', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toEqual(['tmux', 'set', '-g', 'status', '2']);
    expect(cmds[1]).toEqual(['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)']);
    expect(cmds[2]![0]).toBe('tmux');
    expect(cmds[2]![1]).toBe('bind');
    expect(cmds[2]).toContain('MouseDown1Status');
  });

  test('all commands invoke tmux', () => {
    const cmds = buildInjectCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('bind uses MouseDown1Status with if-shell guard for row 1 only', () => {
    const cmds = buildInjectCommands();
    const bindCmd = cmds.find((c) => c[1] === 'bind');
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
});

describe('buildRemoveCommands', () => {
  test('returns unset status-format[1], reset status, and unbind commands', () => {
    const cmds = buildRemoveCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '-u', 'status-format[1]'],
      ['tmux', 'set', '-g', 'status', 'on'],
      ['tmux', 'unbind', '-T', 'root', 'MouseDown1Status'],
    ]);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildRemoveCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('includes an unbind for MouseDown1Status', () => {
    const cmds = buildRemoveCommands();
    const unbindCmd = cmds.find((c) => c[1] === 'unbind');
    expect(unbindCmd).toContain('MouseDown1Status');
  });
});
