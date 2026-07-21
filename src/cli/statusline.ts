/**
 * Manage the second tmux status row that displays `fleet status --statusline`.
 *
 * Inject sets `status` to 2 (two-row status bar) and `status-format[1]` to call
 * `fleet status --statusline` for the second row content. Remove unsets the
 * second-row format and restores the single-row status bar.
 */

import { windowColorArgs } from './status.ts';
import { getTmuxOption, tmux } from '../tmux/ipc.ts';
import type { AgentState } from '../state/types.ts';

// Fire only on row 1 (the fleet row) and only when the click landed on a named
// range — either an agent's pane id or the "clear all" sentinel. Both route
// through fleet, which decides what to do based on the range value.
const ROW1_RANGE_GUARD = '#{&&:#{==:#{mouse_status_line},1},#{!=:#{mouse_status_range},}}';

// Clearing a notification by *reaching* the pane, not just by clicking its Fleet
// chip. A pane-focus-in hook acks whatever pane just gained focus, so switching
// to a ready agent by any route (prefix keys, clicking the pane, choose-tree)
// retires its chip. `fleet ack` self-gates to DONE — focusing a working/permit/
// question pane is a no-op (those clear themselves once the on-screen prompt is
// answered). `[99]` namespaces our hook so it coexists with any user pane-focus-in
// hook at `[0]`; `-b` backgrounds it so a pane switch never waits on fleet.
const FOCUS_HOOK_INDEX = 'pane-focus-in[99]';
const FOCUS_HOOK_ACTION = 'run-shell -b "fleet ack \\"#{pane_id}\\""';

// Window state rollup formats. The conditional `#{?#{@fleet_state},...,...}`
// tints the entry only when the per-window option is present; unset windows
// fall through to tmux's default look. `#F` keeps window flags; current-window
// emphasis is preserved via the untouched window-status-current-style plus the
// `#[bold]` prefix on the current format. Exported so install.ts can persist
// them as `# fleet-managed` conf lines from the same source of truth.
export const WINDOW_STATUS_FORMAT = '#{?#{@fleet_state},#[fg=#{@fleet_state}],}#I:#W#F';
export const WINDOW_STATUS_CURRENT_FORMAT = '#{?#{@fleet_state},#[fg=#{@fleet_state}],}#[bold]#I:#W#F#[nobold]';

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
    // pane-focus-in requires focus-events; switching to a pane then acks it.
    ['tmux', 'set', '-g', 'focus-events', 'on'],
    ['tmux', 'set-hook', '-g', FOCUS_HOOK_INDEX, FOCUS_HOOK_ACTION],
  ];
}

// Live enable for the window state rollup: set the gate option and override the
// window-status formats. Mirrors runStatusLineInject applying the statusline
// live rather than waiting for a config reload. The persisted `# fleet-managed`
// conf lines (written by install.ts) reapply this on every future tmux start.
export function buildRollupEnableCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', '@fleet_rollup', '1'],
    ['tmux', 'set', '-g', 'window-status-format', WINDOW_STATUS_FORMAT],
    ['tmux', 'set', '-g', 'window-status-current-format', WINDOW_STATUS_CURRENT_FORMAT],
  ];
}

export function buildRemoveCommands(): string[][] {
  return [
    ['tmux', 'set', '-g', '-u', 'status-format[1]'],
    ['tmux', 'set', '-g', 'status', 'on'],
    ['tmux', 'unbind', '-T', 'root', 'MouseDown1Status'],
    ['tmux', 'unbind', '-T', 'root', 'MouseDown3Status'],
    // Remove only our indexed hook; leave focus-events as we found it (we can't
    // know the user's prior value, and leaving it on is harmless).
    ['tmux', 'set-hook', '-gu', FOCUS_HOOK_INDEX],
    // Window state rollup revert. `set -g -u` reverts the format to tmux's
    // DEFAULT (a user's own custom format reasserts on the next config reload
    // after the # fleet-managed line is stripped — see spec Failure Modes).
    ['tmux', 'set', '-g', '-u', 'window-status-format'],
    ['tmux', 'set', '-g', '-u', 'window-status-current-format'],
    ['tmux', 'set', '-g', '-u', '@fleet_rollup'],
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

// Gate: only emit window colors when the user opted in. Cheap (~2ms) and
// only paid by users who have the statusline installed at all.
export function rollupEnabled(): boolean {
  return getTmuxOption('@fleet_rollup') === '1';
}

// One batched tmux call for all windows: `tmux set ... ; set -w -u ... ; ...`.
// tmux treats a lone ";" arg as a command separator, so N windows = 1 spawn.
// Failures (not in tmux, window closed mid-batch) are non-critical — the next
// redraw retries.
export function emitWindowColors(states: AgentState[]): void {
  const groups = windowColorArgs(states);
  if (groups.length === 0) return;
  const flat: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) flat.push(';');
    flat.push(...groups[i]!);
  }
  tmux(flat);
}

// Sweep every window's @fleet_state so no stale tint lingers after uninstall —
// including windows that have no fleet pane. Dynamic (lists live windows), so it
// lives outside the static buildRemoveCommands array.
export function clearAllWindowStates(): void {
  const p = tmux(['list-windows', '-a', '-F', '#{window_id}']);
  if (p.exitCode !== 0) return;
  const flat: string[] = [];
  for (const id of p.stdout.split('\n')) {
    if (id.length === 0) continue;
    if (flat.length > 0) flat.push(';');
    flat.push('set', '-w', '-u', '-t', id, '@fleet_state');
  }
  if (flat.length > 0) tmux(flat);
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
  // Sweep any residual per-window @fleet_state left by the rollup, regardless of
  // the command exit code — the options must not survive an uninstall.
  clearAllWindowStates();
  if (code === 0) {
    process.stdout.write('Fleet status line removed. tmux status bar reset to single row.\n');
  }
  return code;
}
