import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import { capturePane } from '../tmux/sessions.ts';

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

function chip(key: string): string {
  return `${C.dim}[${C.reset}${C.bold}${key}${C.reset}${C.dim}]${C.reset}`;
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
  const claudeInfo = state.claudeName ? ` · ${state.claudeName}` : '';
  const title = `${display.icon} ${state.session} · ${display.label.toUpperCase()}${claudeInfo}${modeTag}`;
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
    paneLines = capturePane(state.paneId, maxContentLines);
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
