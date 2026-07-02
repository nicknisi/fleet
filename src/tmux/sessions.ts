import { tmux, tmuxOrNull, tmuxOrThrow } from './ipc.ts';

export interface PaneInfo {
  paneId: string;
  paneNum: number;
  sessionName: string;
  windowName: string;
  currentPath: string;
  panePid: number;
  paneTitle: string;
}

const PANE_FORMAT = '#{pane_id}\t#{session_name}\t#{window_name}\t#{pane_current_path}\t#{pane_pid}\t#{pane_title}';

export interface ListPanesResult {
  ok: boolean;
  panes: PaneInfo[];
}

export function listPanesResult(): ListPanesResult {
  const result = tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (result.exitCode !== 0) return { ok: false, panes: [] };

  const panes: PaneInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const paneId = parts[0]!;
    panes.push({
      paneId,
      paneNum: parseInt(paneId.replace('%', ''), 10),
      sessionName: parts[1]!,
      windowName: parts[2]!,
      currentPath: parts[3]!,
      panePid: parseInt(parts[4]!, 10),
      paneTitle: parts[5]!,
    });
  }
  return { ok: true, panes };
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
