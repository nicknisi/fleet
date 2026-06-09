/**
 * Manage the second tmux status row that displays `fleet status --statusline`.
 *
 * Inject sets `status` to 2 (two-row status bar) and `status-format[1]` to call
 * `fleet status --statusline` for the second row content. Remove unsets the
 * second-row format and restores the single-row status bar.
 */

// Fire only on row 1 (the fleet row) and only when the click landed on a named
// range — either an agent's pane id or the "clear all" sentinel. Both route
// through fleet, which decides what to do based on the range value.
const ROW1_RANGE_GUARD = '#{&&:#{==:#{mouse_status_line},1},#{!=:#{mouse_status_range},}}';

export function buildInjectCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', 'status', '2'],
    ['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)'],
    // Left-click: switch to the agent (acknowledging it on the way), or clear all
    // ready agents when the sentinel chip is clicked.
    [
      'tmux',
      'bind',
      '-T',
      'root',
      'MouseDown1Status',
      'if-shell',
      '-F',
      ROW1_RANGE_GUARD,
      'run-shell "fleet switch \\"#{mouse_status_range}\\""',
      'select-window -t=',
    ],
    // Right-click: acknowledge in place without switching (or clear all on the chip).
    [
      'tmux',
      'bind',
      '-T',
      'root',
      'MouseDown3Status',
      'if-shell',
      '-F',
      ROW1_RANGE_GUARD,
      'run-shell "fleet ack \\"#{mouse_status_range}\\""',
    ],
  ];
}

export function buildRemoveCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', '-u', 'status-format[1]'],
    ['tmux', 'set', '-g', 'status', 'on'],
    ['tmux', 'unbind', '-T', 'root', 'MouseDown1Status'],
    ['tmux', 'unbind', '-T', 'root', 'MouseDown3Status'],
  ];
}

function runCommands(commands: string[][]): number {
  for (const cmd of commands) {
    const proc = Bun.spawnSync({
      cmd,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (proc.exitCode !== 0) {
      process.stderr.write(`Command failed: ${cmd.join(' ')}\n`);
      return proc.exitCode ?? 1;
    }
  }
  return 0;
}

export function runStatusLineInject(): number {
  const code = runCommands(buildInjectCommands());
  if (code === 0) {
    process.stdout.write('Fleet status line injected. tmux will now render `fleet status --statusline` on row 2.\n');
  }
  return code;
}

export function runStatusLineRemove(): number {
  const code = runCommands(buildRemoveCommands());
  if (code === 0) {
    process.stdout.write('Fleet status line removed. tmux status bar reset to single row.\n');
  }
  return code;
}
