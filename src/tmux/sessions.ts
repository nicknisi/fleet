import { tmux, tmuxAsync, tmuxOrNull, tmuxOrThrow } from './ipc.ts';

export interface PaneInfo {
  paneId: string;
  paneNum: number;
  sessionName: string;
  windowName: string;
  windowId: string; // e.g. "@5" — stable, server-unique; the grouping key + `set -t` target
  windowIndex: number; // e.g. 2 — per-session position; captured for debugging, NOT a key
  currentPath: string;
  panePid: number;
  // The user is looking at this pane right now: it is the active pane of the
  // active window of a session with at least one attached client. Drives the
  // "finished while you were elsewhere" logic — a DONE synthesized for a
  // discovered agent is suppressed/cleared when its pane is focused.
  focused: boolean;
  paneTitle: string;
}

// Fields are inserted BEFORE pane_title so it stays LAST: a stray tab in a pane
// title then lands in trailing (ignored) parts instead of shifting a field.
export const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_name}\t#{window_id}\t#{window_index}\t#{pane_current_path}\t#{pane_pid}\t#{pane_active}\t#{window_active}\t#{session_attached}\t#{pane_title}';

export interface ListPanesResult {
  ok: boolean;
  panes: PaneInfo[];
}

// Extracted so windowId/windowIndex parsing is unit-testable without live tmux.
export function parsePanesOutput(stdout: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 11) continue;
    const paneId = parts[0]!;
    panes.push({
      paneId,
      paneNum: parseInt(paneId.replace('%', ''), 10),
      sessionName: parts[1]!,
      windowName: parts[2]!,
      windowId: parts[3]!,
      windowIndex: parseInt(parts[4]!, 10),
      currentPath: parts[5]!,
      panePid: parseInt(parts[6]!, 10),
      // pane_active/window_active are 1/0; session_attached counts clients.
      focused: parts[7] === '1' && parts[8] === '1' && parseInt(parts[9]!, 10) > 0,
      // Title is the last field, so a tab inside it split into extra parts —
      // rejoin them instead of silently truncating at the first tab.
      paneTitle: parts.slice(10).join('\t'),
    });
  }
  return panes;
}

// Argv the fork path feeds to `tmux` (one literal arg, tabs preserved).
export function listPanesArgs(): string[] {
  return ['list-panes', '-a', '-F', PANE_FORMAT];
}

// The same scan as a single control-mode command line. PANE_FORMAT contains
// literal tab separators, so it MUST be single-quoted — tmux's command parser
// splits an unquoted argument on whitespace (tabs included) and the format
// would be broken across tokens. PANE_FORMAT has no single-quote chars.
export function listPanesCommand(): string {
  return `list-panes -a -F '${PANE_FORMAT}'`;
}

export function listPanesResult(): ListPanesResult {
  const result = tmux(listPanesArgs());
  if (result.exitCode !== 0) return { ok: false, panes: [] };
  return { ok: true, panes: parsePanesOutput(result.stdout) };
}

// Async variant for the TUI tick paths — same parse, non-blocking fork.
export async function listPanesResultAsync(): Promise<ListPanesResult> {
  const result = await tmuxAsync(listPanesArgs());
  if (result.exitCode !== 0) return { ok: false, panes: [] };
  return { ok: true, panes: parsePanesOutput(result.stdout) };
}

export function listPanes(): PaneInfo[] {
  return listPanesResult().panes;
}

// Shared post-processing for capture-pane output (fork `-p` text and control
// save-buffer text alike): strip trailing whitespace per line, drop trailing
// blank lines, then keep only the bottom `maxLines` window. Extracted so the
// control-mode adapter produces byte-identical line arrays to the fork path.
export function processCaptureOutput(output: string, maxLines: number): string[] {
  const lines = output.split('\n').map((line) => line.replace(/[\s ]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const start = Math.max(0, lines.length - maxLines);
  return lines.slice(start);
}

export function capturePane(paneId: string, maxLines: number): string[] {
  const output = tmuxOrThrow(['capture-pane', '-e', '-p', '-t', paneId], 'capture-pane failed');
  return processCaptureOutput(output, maxLines);
}

// Read-only plain capture for `fleet capture`: no `-e`, so escape sequences are
// stripped and the bottom `maxLines` come back as clean text. Returns [] on any
// tmux failure (dead server, gone pane) so the caller degrades instead of
// throwing. Never mutates anything — capture-pane only reads.
export function capturePanePlain(paneId: string, maxLines: number): string[] {
  const output = tmuxOrNull(['capture-pane', '-p', '-t', paneId]);
  if (output === null) return [];
  return processCaptureOutput(output, maxLines);
}

export function currentSessionName(): string | null {
  return tmuxOrNull(['display-message', '-p', '#S']);
}

export function currentPaneId(): string | null {
  return tmuxOrNull(['display-message', '-p', '#{pane_id}']);
}

export function switchClient(target: string): void {
  tmuxOrThrow(['switch-client', '-t', target], `switch-client failed for '${target}'`);
}

export function killPane(paneId: string): void {
  tmuxOrThrow(['kill-pane', '-t', paneId], `kill-pane failed for '${paneId}'`);
}

export function displayMessage(msg: string, durationMs: number = 3000): void {
  tmux(['display-message', '-d', String(durationMs), msg]);
}
