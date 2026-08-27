import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, agentSessionName, whereLabel, type AgentState } from '../state/types.ts';
import { capturePane } from '../tmux/sessions.ts';
import { chip } from './layouts/shared.ts';

// render() runs per frame (keystrokes, mouse-motion hover, the 500ms BUSY
// pulse), and each capturePane is a blocking tmux spawn. A short TTL caps that
// at ~2 spawns/sec per pane; frames between refreshes reuse the last lines.
const PREVIEW_TTL_MS = 400;
const previewCaptureCache = new Map<string, { at: number; maxLines: number; lines: string[] }>();

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

export function renderPreview(
  state: AgentState,
  width: number,
  height: number,
  passthrough: boolean = false,
): string[] {
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

  const hasActions = !passthrough;
  const actionLine = hasActions ? previewActions(state) : '';
  const reserveBottom = hasActions && actionLine.length > 0 ? 2 : 0;
  const maxContentLines = height - 2 - reserveBottom;

  let paneLines: string[];
  try {
    paneLines = captureForPreview(state.paneId, maxContentLines, Date.now());
  } catch {
    lines.push(`${C.gray}Preview unavailable${C.reset}`);
    return lines;
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

  return lines.slice(0, height);
}
