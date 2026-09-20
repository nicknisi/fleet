import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, agentSessionName, whereLabel, type AgentState } from '../state/types.ts';
import { processCaptureAligned, processCaptureOutput } from '../tmux/sessions.ts';
import { tmuxAsync } from '../tmux/ipc.ts';
import type { TmuxControlClient } from '../tmux/control.ts';
import { chip, stateIcon } from './layouts/shared.ts';

// Cursor cell inside a rendered preview, in coordinates relative to the returned
// `lines` array: `row` indexes that array, `col` is the 0-based content column
// (before the divider offset the frame adds). render() maps this to an absolute
// screen position and shows the hardware cursor there — the natural typing caret
// in passthrough. null when the pane cursor is off the shown window.
export interface PreviewCursor {
  row: number;
  col: number;
}

// A rendered preview plus the caret cell (null outside passthrough / off-screen).
export interface PreviewRender {
  lines: string[];
  cursor: PreviewCursor | null;
}

export interface PreviewSnapshot {
  paneId: string;
  screen: string;
  cursor: { x: number; y: number } | null;
  at: number;
}

// Observation is asynchronous and separate from rendering. Control mode avoids
// forks entirely; fallback combines capture and cursor in one async tmux call.
export async function readPreview(
  paneId: string,
  client: Pick<TmuxControlClient, 'capturePane' | 'run'> | null = null,
): Promise<PreviewSnapshot> {
  if (!/^%\d+$/.test(paneId)) throw new Error('Invalid preview target');
  let screen: string;
  let cursorText: string;
  const format = '#{cursor_x},#{cursor_y}';
  if (client) {
    [screen, cursorText] = await Promise.all([
      client.capturePane(paneId, true),
      client.run(`display-message -p -t ${paneId} '${format}'`),
    ]);
  } else {
    const result = await tmuxAsync([
      'capture-pane',
      '-e',
      '-p',
      '-t',
      paneId,
      ';',
      'display-message',
      '-p',
      '-t',
      paneId,
      format,
    ]);
    if (result.exitCode !== 0) throw new Error('Preview unavailable');
    const lines = result.stdout.trimEnd().split('\n');
    cursorText = lines.pop() ?? '';
    screen = lines.join('\n') + '\n';
  }
  const match = /^(\d+),(\d+)$/.exec(cursorText.trim());
  const cursor = match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  return { paneId, screen, cursor, at: Date.now() };
}

export function previewActions(state: AgentState): string {
  switch (state.status) {
    case AgentStatus.PERMIT:
      return `${chip('y')} ${C.done}approve${C.reset}  ${chip('n')} ${C.red}deny${C.reset}  ${chip('i')} ${C.gray}passthrough${C.reset}`;
    case AgentStatus.QUESTION:
      return `${chip('i')} ${C.gray}answer inline${C.reset}`;
    case AgentStatus.DONE:
    case AgentStatus.IDLE:
      return `${chip('i')} ${C.gray}passthrough${C.reset}  ${chip('s')} ${C.gray}send prompt${C.reset}`;
    case AgentStatus.BUSY:
      return `${chip('i')} ${C.gray}passthrough${C.reset}`;
    default:
      return '';
  }
}

// Back-compat wrapper: callers wanting only the rendered lines (and every test)
// use this; render() uses renderPreviewWithCursor to also place the caret.
export function renderPreview(
  state: AgentState,
  width: number,
  height: number,
  passthrough: boolean = false,
): string[] {
  return renderPreviewWithCursor(state, width, height, passthrough).lines;
}

export function renderPreviewWithCursor(
  state: AgentState,
  width: number,
  height: number,
  passthrough: boolean = false,
  frame: number = 0,
  snapshot: PreviewSnapshot | null = null,
): PreviewRender {
  const lines: string[] = [];
  const display = STATUS_DISPLAY[state.status];

  const modeTag = passthrough ? ` ${C.cyan}● LIVE${C.reset}` : '';
  const agentName = agentSessionName(state);
  const nameInfo = agentName ? ` · ${agentName}` : '';
  const title = `${stateIcon(state.status, frame)} ${whereLabel(state)} · ${display.label.toUpperCase()}${nameInfo}${modeTag}`;
  const toolInfo = state.tool ? ` · ${state.tool}` : '';
  const portInfo = state.ports.length > 0 ? ` · ⌁${state.ports.join(',')}` : '';
  lines.push(truncateAnsi(`${C.bold}${title}${C.reset}${C.gray}${toolInfo}${portInfo}${C.reset}`, width));
  lines.push(`${C.gray}${'─'.repeat(width)}${C.reset}`);
  // Pane content starts after the title + separator rows above.
  const CONTENT_ROW_OFFSET = 2;

  const hasActions = !passthrough;
  const actionLine = hasActions ? previewActions(state) : '';
  const reserveBottom = hasActions && actionLine.length > 0 ? 2 : 0;
  const maxContentLines = height - 2 - reserveBottom;

  let paneLines: string[];
  let cursor: PreviewCursor | null = null;
  if (!snapshot || snapshot.paneId !== state.paneId) {
    paneLines = [`${C.gray}Loading preview…${C.reset}`];
  } else if (passthrough) {
    const aligned = processCaptureAligned(snapshot.screen, Math.max(1, maxContentLines));
    paneLines = aligned.lines;
    const pc = snapshot.cursor;
    if (pc) {
      const contentRow = pc.y - aligned.droppedTop;
      if (contentRow >= 0 && contentRow < paneLines.length && pc.x >= 0 && pc.x < width) {
        cursor = { row: CONTENT_ROW_OFFSET + contentRow, col: pc.x };
      }
    }
  } else {
    paneLines = processCaptureOutput(snapshot.screen, Math.max(1, maxContentLines));
  }

  for (const line of paneLines) {
    lines.push(truncateAnsi(line, width));
  }

  while (lines.length < height - reserveBottom) {
    lines.push('');
  }

  if (reserveBottom > 0) {
    lines.push(`${C.gray}${'─'.repeat(width)}${C.reset}`);
    lines.push(truncateAnsi(actionLine, width));
  }

  return { lines: lines.slice(0, height), cursor };
}
