import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import { capturePane } from '../tmux/sessions.ts';

export function renderPreview(state: AgentState, width: number, height: number): string[] {
  const lines: string[] = [];
  const display = STATUS_DISPLAY[state.status];

  const title = `${display.icon} ${state.session} · ${state.status}`;
  const toolInfo = state.tool ? ` · ${state.tool}` : '';
  const portInfo = state.ports.length > 0 ? ` · ⌁${state.ports.join(',')}` : '';
  lines.push(truncateAnsi(`${C.bold}${title}${C.reset}${C.gray}${toolInfo}${portInfo}${C.reset}`, width));
  lines.push(`${C.gray}${'─'.repeat(width)}${C.reset}`);

  const maxContentLines = height - 2;
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

  while (lines.length < height) {
    lines.push('');
  }

  return lines.slice(0, height);
}
