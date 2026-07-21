import { tmux, tmuxOrNull, tmuxOrThrow } from './ipc.ts';

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
const PANE_FORMAT =
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
      paneTitle: parts[10]!,
    });
  }
  return panes;
}

export function listPanesResult(): ListPanesResult {
  const result = tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (result.exitCode !== 0) return { ok: false, panes: [] };
  return { ok: true, panes: parsePanesOutput(result.stdout) };
}

export function listPanes(): PaneInfo[] {
  return listPanesResult().panes;
}

export function capturePane(paneId: string, maxLines: number): string[] {
  const output = tmuxOrThrow(['capture-pane', '-e', '-p', '-t', paneId], 'capture-pane failed');
  const lines = output.split('\n').map((line) => line.replace(/[\s ]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const start = Math.max(0, lines.length - maxLines);
  return lines.slice(start);
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

export function gitBranch(path: string): string | null {
  const proc = Bun.spawnSync({
    cmd: ['git', '-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const branch = proc.stdout.toString().trim();
  return branch.length > 0 ? branch : null;
}
