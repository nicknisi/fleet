import { C } from '../terminal/colors.ts';
import { AgentStatus, sessionLabel, type AgentState } from '../state/types.ts';

// Killing is destructive, so it gets the same state gating as send: refuse the
// states where the agent is mid-thought or blocked on you. You can still reap
// anything that's finished, idle, or already dead.
export function canKillSession(state: AgentState): { ok: boolean; reason: string } {
  switch (state.status) {
    case AgentStatus.IDLE:
    case AgentStatus.DONE:
    case AgentStatus.SHELL:
    case AgentStatus.DOWN:
      return { ok: true, reason: '' };
    case AgentStatus.BUSY:
      return { ok: false, reason: 'Agent is working' };
    case AgentStatus.PERMIT:
      return { ok: false, reason: 'Agent has a permission prompt' };
    case AgentStatus.QUESTION:
      return { ok: false, reason: 'Agent is asking a question' };
  }
}

export function renderKillConfirm(state: AgentState): string[] {
  const lines: string[] = [];
  const check = canKillSession(state);
  const label = state.claudeName ? `${sessionLabel(state)} (${state.claudeName})` : sessionLabel(state);

  lines.push(`${C.bold}Kill ${label}?${C.reset}`);
  lines.push('');

  if (!check.ok) {
    lines.push(`${C.red}Cannot kill: ${check.reason}${C.reset}`);
    lines.push(`${C.gray}Press Esc to cancel${C.reset}`);
    return lines;
  }

  lines.push(
    `${C.gray}This closes the tmux pane. ${C.reset}${C.yellowBold}y${C.reset}${C.gray} to confirm, Esc to cancel${C.reset}`,
  );
  return lines;
}
