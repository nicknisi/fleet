import { describe, expect, test } from 'bun:test';
import { buildInjectCommands, buildRemoveCommands } from './statusline.ts';

describe('buildInjectCommands', () => {
  test('returns enable status-2, status-format[1], and Status mouse bind commands', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', 'status', '2'],
      ['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)'],
      ['tmux', 'bind', '-T', 'root', 'Status', 'run-shell', 'tmux switch-client -t "#{mouse_status_range}"'],
    ]);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildInjectCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('includes a bind for the Status mouse key', () => {
    const cmds = buildInjectCommands();
    const bindCmd = cmds.find((c) => c[1] === 'bind');
    expect(bindCmd).toBeDefined();
    expect(bindCmd).toEqual([
      'tmux',
      'bind',
      '-T',
      'root',
      'Status',
      'run-shell',
      'tmux switch-client -t "#{mouse_status_range}"',
    ]);
  });
});

describe('buildRemoveCommands', () => {
  test('returns unset status-format[1], reset status, and unbind Status commands', () => {
    const cmds = buildRemoveCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '-u', 'status-format[1]'],
      ['tmux', 'set', '-g', 'status', 'on'],
      ['tmux', 'unbind', '-T', 'root', 'Status'],
    ]);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildRemoveCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });

  test('includes an unbind for the Status mouse key', () => {
    const cmds = buildRemoveCommands();
    const unbindCmd = cmds.find((c) => c[1] === 'unbind');
    expect(unbindCmd).toEqual(['tmux', 'unbind', '-T', 'root', 'Status']);
  });
});
