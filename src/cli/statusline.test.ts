import { describe, expect, test } from 'bun:test';
import { buildInjectCommands, buildRemoveCommands } from './statusline.ts';

describe('buildInjectCommands', () => {
  test('returns enable status-2 and status-format[1] commands', () => {
    const cmds = buildInjectCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', 'status', '2'],
      ['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)'],
    ]);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildInjectCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });
});

describe('buildRemoveCommands', () => {
  test('returns unset status-format[1] and reset status commands', () => {
    const cmds = buildRemoveCommands();
    expect(cmds).toEqual([
      ['tmux', 'set', '-g', '-u', 'status-format[1]'],
      ['tmux', 'set', '-g', 'status', 'on'],
    ]);
  });

  test('all commands invoke tmux', () => {
    const cmds = buildRemoveCommands();
    for (const cmd of cmds) {
      expect(cmd[0]).toBe('tmux');
    }
  });
});
