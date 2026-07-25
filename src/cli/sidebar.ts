/**
 * The `☰ fleet` button on the status line: toggle a fleet sidebar split in the
 * window the click came from.
 *
 * The sidebar pane is identified by a pane-scoped marker option, not by matching
 * `pane_current_command` — under `bun run dev` the pane reports as `bun`, and any
 * shell that merely *ran* fleet once would false-positive.
 */

import { tmux, tmuxOrNull } from '../tmux/ipc.ts';

// Shared with the prefix+f conf line install.ts persists, so a click and the
// keybind can never drift to different widths.
export const SIDEBAR_WIDTH = 34;

// Pane-scoped marker set on the split we create; `list-panes -f` filters on it.
const SIDEBAR_OPTION = '@fleet_sidebar';

// `-t <pane>` scopes list-panes to that pane's *window*, which is what makes the
// toggle land where the click came from. A null target falls back to whatever
// tmux considers current — right for `fleet sidebar` typed in a shell, but wrong
// with two clients on different windows, so the status-line binding always
// passes `#{pane_id}` (verified to expand to the clicking client's active pane;
// $TMUX_PANE does NOT — it carries the tmux server's inherited environment).
export function buildFindArgs(target: string | null): string[] {
  const args = ['list-panes', '-f', `#{${SIDEBAR_OPTION}}`, '-F', '#{pane_id}'];
  if (target !== null) args.push('-t', target);
  return args;
}

// -h vertical divider, -b before (left of) the target, -f full window height.
// -P -F prints the new pane id so we can mark it in the very next call.
export function buildOpenArgs(target: string | null): string[] {
  const args = ['split-window', '-hbf', '-l', String(SIDEBAR_WIDTH), '-P', '-F', '#{pane_id}'];
  if (target !== null) args.push('-t', target);
  args.push('fleet');
  return args;
}

export function buildMarkArgs(paneId: string): string[] {
  return ['set', '-p', '-t', paneId, SIDEBAR_OPTION, '1'];
}

export function buildCloseArgs(paneId: string): string[] {
  return ['kill-pane', '-t', paneId];
}

// Open when absent, close when present. Both halves are best-effort: a pane that
// vanished between the list and the kill just leaves the toggle in the state the
// user wanted anyway.
export function toggleSidebar(target: string | null): number {
  const found = tmuxOrNull(buildFindArgs(target));
  if (found !== null) {
    // Normally one id. Kill every marked pane so a hand-marked stray can't wedge
    // the toggle into permanently reporting "already open".
    for (const paneId of found.split('\n')) {
      if (paneId.length > 0) tmux(buildCloseArgs(paneId));
    }
    return 0;
  }

  const created = tmuxOrNull(buildOpenArgs(target));
  if (created === null) {
    process.stderr.write('fleet sidebar: split-window failed (not inside tmux?)\n');
    return 1;
  }
  tmux(buildMarkArgs(created));
  return 0;
}

// `fleet sidebar [--from <pane>]`. The flag exists for the status-line binding;
// typed by hand the bare form is correct.
export function runSidebar(args: string[]): number {
  const fromIndex = args.indexOf('--from');
  const target = fromIndex !== -1 ? (args[fromIndex + 1] ?? null) : null;
  return toggleSidebar(target);
}
