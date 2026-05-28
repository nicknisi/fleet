/**
 * Manage the second tmux status row that displays `fleet status --statusline`.
 *
 * Inject sets `status` to 2 (two-row status bar) and `status-format[1]` to call
 * `fleet status --statusline` for the second row content. Remove unsets the
 * second-row format and restores the single-row status bar.
 */

export function buildInjectCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', 'status', '2'],
    ['tmux', 'set', '-g', 'status-format[1]', '#[align=left]#(fleet status --statusline)'],
  ];
}

export function buildRemoveCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', '-u', 'status-format[1]'],
    ['tmux', 'set', '-g', 'status', 'on'],
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
