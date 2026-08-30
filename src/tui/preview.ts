import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, agentSessionName, whereLabel, type AgentState } from '../state/types.ts';
import { capturePane, capturePaneAligned, paneCursor, type AlignedCapture } from '../tmux/sessions.ts';
import { chip } from './layouts/shared.ts';

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

// render() runs per frame (keystrokes, mouse-motion hover, the 500ms BUSY
// pulse), and each capturePane is a blocking tmux spawn. A short TTL caps that
// at ~2 spawns/sec per pane; frames between refreshes reuse the last lines.
const PREVIEW_TTL_MS = 400;
const previewCaptureCache = new Map<string, { at: number; maxLines: number; lines: string[] }>();
// Separate cache for the row-aligned passthrough capture — it keeps trailing
// blanks (unlike the trimmed cache) so it can't share entries with the above.
const alignedCaptureCache = new Map<string, { at: number; maxLines: number; cap: AlignedCapture }>();

// TTL-gated pane capture. `now`/`fetch` injected for tests; fetch does the
// real spawn. A cached capture larger than the request serves its tail.
export function captureForPreview(
  paneId: string,
  maxLines: number,
  now: number,
  fetch: (paneId: string, maxLines: number) => string[] = capturePane,
): string[] {
  const hit = previewCaptureCache.get(paneId);
  if (hit && now - hit.at < PREVIEW_TTL_MS && hit.maxLines >= maxLines) {
    return hit.lines.slice(-maxLines);
  }
  const lines = fetch(paneId, maxLines);
  previewCaptureCache.set(paneId, { at: now, maxLines, lines });
  return lines;
}

// TTL-gated row-aligned capture (passthrough only). Mirrors captureForPreview
// but preserves row alignment for cursor mapping. `fetch` injected for tests.
export function captureAlignedForPreview(
  paneId: string,
  maxLines: number,
  now: number,
  fetch: (paneId: string, maxLines: number) => AlignedCapture = capturePaneAligned,
): AlignedCapture {
  const hit = alignedCaptureCache.get(paneId);
  if (hit && now - hit.at < PREVIEW_TTL_MS && hit.maxLines === maxLines) {
    return hit.cap;
  }
  const cap = fetch(paneId, maxLines);
  alignedCaptureCache.set(paneId, { at: now, maxLines, cap });
  return cap;
}

// Drop the cached captures so the next capture forces a fresh spawn. Passthrough
// calls this on its live-refresh tick so the preview (and cursor) track the
// pane's echo/output at the passthrough cadence instead of the 400ms TTL.
// No argument clears every pane.
export function invalidatePreviewCache(paneId?: string): void {
  if (paneId === undefined) {
    previewCaptureCache.clear();
    alignedCaptureCache.clear();
  } else {
    previewCaptureCache.delete(paneId);
    alignedCaptureCache.delete(paneId);
  }
}

export function previewActions(state: AgentState): string {
  switch (state.status) {
    case AgentStatus.PERMIT:
      return `${chip('y')} ${C.done}approve${C.reset}  ${chip('n')} ${C.red}deny${C.reset}  ${chip('i')} ${C.gray}passthrough${C.reset}`;
    case AgentStatus.QUESTION:
      return `${chip('i')} ${C.gray}answer inline${C.reset}  ${chip('s')} ${C.gray}send prompt${C.reset}`;
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
): PreviewRender {
  const lines: string[] = [];
  const display = STATUS_DISPLAY[state.status];

  const modeTag = passthrough ? ` ${C.cyan}● LIVE${C.reset}` : '';
  const agentName = agentSessionName(state);
  const nameInfo = agentName ? ` · ${agentName}` : '';
  const title = `${display.icon} ${whereLabel(state)} · ${display.label.toUpperCase()}${nameInfo}${modeTag}`;
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
  try {
    if (passthrough) {
      // Row-aligned capture so tmux's cursor_y maps to a preview row.
      const now = Date.now();
      const aligned = captureAlignedForPreview(state.paneId, maxContentLines, now);
      paneLines = aligned.lines;
      const pc = paneCursor(state.paneId);
      if (pc) {
        const contentRow = pc.y - aligned.droppedTop;
        if (contentRow >= 0 && contentRow < paneLines.length && pc.x >= 0 && pc.x < width) {
          cursor = { row: CONTENT_ROW_OFFSET + contentRow, col: pc.x };
        }
      }
    } else {
      paneLines = captureForPreview(state.paneId, maxContentLines, Date.now());
    }
  } catch {
    lines.push(`${C.gray}Preview unavailable${C.reset}`);
    return { lines, cursor: null };
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
