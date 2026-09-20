/**
 * Manage the tmux status row that displays `fleet status --statusline`.
 *
 * Inject sets `status` to 2 (two-row status bar) and `status-format[1]` to call
 * `fleet status --statusline` for the second row content, then binds the mouse
 * and the focus hook. Remove unsets the second-row format and restores the
 * single-row status bar.
 *
 * Two tmux user options, set in tmux.conf ABOVE the fleet-managed inject line,
 * adapt this to a bar fleet doesn't own:
 *
 *   set -g @fleet_statusline_row none   # keep one row; you mount
 *                                       # #(fleet status --statusline) yourself
 *   set -g @fleet_chip_separator none   # no │ between chips (or any string)
 */

import { DEFAULT_CHIP_SEPARATOR, windowColorArgs } from './status.ts';
import { getTmuxOption, tmux } from '../tmux/ipc.ts';
import type { AgentState } from '../state/types.ts';

// Fire only when the click landed on one of fleet's own named ranges — an
// agent's pane id (%N) or a __sentinel__ chip (sidebar, clear all) — on
// whichever row the chips were mounted. tmux reports a click on the window
// list as the range "window", and another tool's user range by its own name;
// both fall through to the else branch. Checking the row instead (the old
// `mouse_status_line == 1` guard) broke every click for users who mount the
// chips on a one-row bar.
//
// The pane-id branch is written as "one character then digits" rather than
// `%*`: tmux runs some format expansions through strftime, where a `%` is a
// conversion specifier — `%*` came out as `*` and matched every range.
const FLEET_RANGE_GUARD = '#{||:#{m/r:^.[0-9]+$,#{mouse_status_range}},#{m:__*,#{mouse_status_range}}}';

// `set -g @fleet_statusline_row none` opts out of fleet owning tmux's second
// row: inject then installs only the mouse bindings and the focus hook, and the
// user mounts `#(fleet status --statusline)` wherever they like (status-right,
// a status-format of their own). Anything else — unset, `1`, `on` — keeps the
// default second row.
export const STATUSLINE_ROW_OPTION = '@fleet_statusline_row';
export function parseOwnsRow(value: string | null): boolean {
  if (value === null) return true;
  const v = value.trim().toLowerCase();
  return !(v === 'none' || v === 'off' || v === '0' || v === 'false');
}
export function ownsRow(): boolean {
  return parseOwnsRow(getTmuxOption(STATUSLINE_ROW_OPTION));
}

// `set -g @fleet_chip_separator <text>` replaces the │ between agent chips;
// `none` (or an empty value) removes it, leaving a two-space gap. The text is
// spliced into tmux format output verbatim, so a literal # must be written ##.
export const CHIP_SEPARATOR_OPTION = '@fleet_chip_separator';
export function parseChipSeparator(value: string | null): string | null {
  if (value === null) return DEFAULT_CHIP_SEPARATOR;
  const v = value.trim();
  if (v.length === 0 || v.toLowerCase() === 'none' || v.toLowerCase() === 'off') return null;
  return v;
}
export function chipSeparator(): string | null {
  // Without -q, an unset option fails while an explicitly empty value succeeds.
  const result = tmux(['show', '-gv', CHIP_SEPARATOR_OPTION]);
  return parseChipSeparator(result.exitCode === 0 ? result.stdout : null);
}

// Which window the click came from. A status-line click carries no pane target
// of its own, so `#{pane_id}` here resolves to the active pane of the clicking
// client's current window — exactly what the sidebar toggle needs to split the
// right window when two clients are attached to different ones. ($TMUX_PANE is
// NOT a substitute: in a run-shell child it carries the tmux server's inherited
// environment, which points at whatever pane happened to start the server.)
// Only the sidebar sentinel reads it; switch/ack on an agent chip ignore it.
const FROM_PANE_ARG = '--from \\"#{pane_id}\\" --client \\"#{client_name}\\"';

// Clearing a notification by *reaching* the pane, not just by clicking its Fleet
// chip. A pane-focus-in hook acks whatever pane just gained focus, so switching
// to a ready agent by any route (prefix keys, clicking the pane, choose-tree)
// retires its chip. `fleet ack` self-gates to DONE — focusing a working/permit/
// question pane is a no-op (those clear themselves once the on-screen prompt is
// answered). `[99]` namespaces our hook so it coexists with any user pane-focus-in
// hook at `[0]`; `-b` backgrounds it so a pane switch never waits on fleet.
const FOCUS_HOOK_INDEX = 'pane-focus-in[99]';
export const FOCUS_HOOK_ACTION = 'run-shell -b "fleet ack \\"#{pane_id}\\""';

// Window state rollup formats. The conditional `#{?#{@fleet_state},...,...}`
// tints the entry only when the per-window option is present; unset windows
// fall through to tmux's default look. `#F` keeps window flags; current-window
// emphasis is preserved via the untouched window-status-current-style plus the
// `#[bold]` prefix on the current format. Exported so install.ts can persist
// them as `# fleet-managed` conf lines from the same source of truth.
export const WINDOW_STATUS_FORMAT = '#{?#{@fleet_state},#[fg=#{@fleet_state}],}#I:#W#F';
export const WINDOW_STATUS_CURRENT_FORMAT = '#{?#{@fleet_state},#[fg=#{@fleet_state}],}#[bold]#I:#W#F#[nobold]';

// Row 1's content. Named so the idempotence check can compare against the exact
// value inject writes, rather than a second copy that could drift.
export const STATUS_ROW1_FORMAT = '#[align=left]#(fleet status --statusline)';

export function buildInjectCommands(ownRow = true): string[][] {
  const row: string[][] = ownRow
    ? [
        ['tmux', 'set', '-g', 'status', '2'],
        ['tmux', 'set', '-g', 'status-format[1]', STATUS_ROW1_FORMAT],
      ]
    : [];
  return [
    ...row,
    // Left-click: switch to the agent (acknowledging it on the way), clear all
    // ready agents on the ✕ chip, or toggle the sidebar on the ☰ button. A
    // click anywhere else on the row selects the window under the mouse, as
    // tmux's default binding would.
    [
      'tmux',
      'bind',
      '-T',
      'root',
      'MouseDown1Status',
      'if-shell',
      '-F',
      FLEET_RANGE_GUARD,
      `run-shell "fleet switch \\"#{mouse_status_range}\\" ${FROM_PANE_ARG}"`,
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
      FLEET_RANGE_GUARD,
      `run-shell "fleet ack \\"#{mouse_status_range}\\" ${FROM_PANE_ARG}"`,
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

export function buildRemoveCommands(ownRow = true): string[][] {
  // Only touch the row fleet owns: a user who mounted the chips on their own
  // bar keeps their `status` value.
  const row: string[][] = ownRow
    ? [
        ['tmux', 'set', '-g', '-u', 'status-format[1]'],
        ['tmux', 'set', '-g', 'status', 'on'],
      ]
    : [];
  return [
    ...row,
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

// Skip identical 500ms ticks, but periodically reassert state in case another
// process changed the options. Transitions and stale-tint clearing stay immediate.
const COLOR_RECONCILE_MS = 5_000;
let lastWindowColors: { server: string | undefined; signature: string; at: number } | undefined;

// One batched tmux call for all windows. Failed batches are never remembered,
// so the next refresh retries even if its desired colors have not changed.
export function emitWindowColors(states: AgentState[], now = Date.now()): void {
  const groups = windowColorArgs(states);
  if (groups.length === 0) {
    lastWindowColors = undefined;
    return;
  }
  const server = process.env.TMUX;
  const signature = JSON.stringify(groups);
  if (
    lastWindowColors?.server === server &&
    lastWindowColors?.signature === signature &&
    now >= lastWindowColors.at &&
    now - lastWindowColors.at < COLOR_RECONCILE_MS
  )
    return;
  const flat: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) flat.push(';');
    flat.push(...groups[i]!);
  }
  // A failed batch may have applied its first commands. Forget the previous
  // signature too, so returning to that state repairs any partial writes.
  lastWindowColors = tmux(flat).exitCode === 0 ? { server, signature, at: now } : undefined;
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

// Whether the live server already carries everything inject would set. Hooks are
// options in tmux 3.x, so `show -gqv` reads all three the same way. Deliberately
// compares values rather than just presence: a fleet upgrade that changes a
// format must still re-apply over the stale one. Without the row there is no
// row to compare, so the hook alone decides.
export function injectedFrom(
  hook: string | null,
  row: { status: string | null; format: string | null } | null,
): boolean {
  const rowApplied = row === null || (row.status === '2' && row.format === STATUS_ROW1_FORMAT);
  return rowApplied && hook === FOCUS_HOOK_ACTION;
}
export function isStatusLineInjected(ownRow = true): boolean {
  const row = ownRow ? { status: getTmuxOption('status'), format: getTmuxOption('status-format[1]') } : null;
  return injectedFrom(getTmuxOption(FOCUS_HOOK_INDEX), row);
}

// install.ts persists a `run-shell "fleet statusline --inject"` line so a fresh
// tmux server gets row 2 — which also means this runs on every `source-file`.
// Silent even when it re-applies: tmux shows run-shell stdout in view mode, and
// a reload that re-asserts row 2 over a conf line that reset `status` is not
// news. Skip the work when the server already matches; --force re-applies.
export function runStatusLineInject(force = false): number {
  const own = ownsRow();
  if (!force && isStatusLineInjected(own)) return 0;

  return runCommands(buildInjectCommands(own));
}

export function runStatusLineRemove(): number {
  const code = runCommands(buildRemoveCommands(ownsRow()));
  // Sweep any residual per-window @fleet_state left by the rollup, regardless of
  // the command exit code — the options must not survive an uninstall.
  clearAllWindowStates();
  if (code === 0) {
    process.stdout.write('Fleet status line removed. tmux status bar reset to single row.\n');
  }
  return code;
}
