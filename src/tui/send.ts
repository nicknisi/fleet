import { C } from '../terminal/colors.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { truncateAnsi } from '../terminal/ansi.ts';

export function canSendTo(state: AgentState): { ok: boolean; reason: string } {
  switch (state.status) {
    case AgentStatus.IDLE:
    case AgentStatus.DONE:
    case AgentStatus.SHELL:
      return { ok: true, reason: '' };
    case AgentStatus.BUSY:
      return { ok: false, reason: 'Agent is busy' };
    case AgentStatus.PERMIT:
      return { ok: false, reason: 'Agent has a permission prompt' };
    case AgentStatus.QUESTION:
      return { ok: false, reason: 'Agent is asking a question' };
    case AgentStatus.DOWN:
      return { ok: false, reason: 'No live process' };
  }
}

export function renderSendMode(state: AgentState, buffer: string, cols: number): string[] {
  const lines: string[] = [];
  const check = canSendTo(state);

  lines.push(`${C.bold}Send to ${state.session}${C.reset}`);
  lines.push('');

  if (!check.ok) {
    lines.push(`${C.red}Cannot send: ${check.reason}${C.reset}`);
    lines.push(`${C.gray}Press Esc to cancel${C.reset}`);
    return lines;
  }

  lines.push(`${C.gray}Type your prompt, Enter to send, Esc to cancel${C.reset}`);
  lines.push('');
  lines.push(truncateAnsi(`${C.cyan}> ${C.reset}${buffer}█`, cols));

  return lines;
}
