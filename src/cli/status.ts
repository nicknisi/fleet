import { AgentStatus, compareStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';

export function formatPlainStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return 'idle 0';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;
  const needsYouCount = sessionStates.filter(
    (s) => s.status === AgentStatus.PERMIT || s.status === AgentStatus.QUESTION || s.status === AgentStatus.DONE,
  ).length;

  return `${mostUrgent} ${needsYouCount}`;
}

export function formatTmuxStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return '';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;

  const needsAttention: AgentStatus[] = [AgentStatus.PERMIT, AgentStatus.QUESTION, AgentStatus.DONE];
  if (!needsAttention.includes(mostUrgent)) return '';

  const display = STATUS_DISPLAY[mostUrgent];
  return `#[fg=${display.color}] ${display.icon} `;
}

export function runStatus(args: string[], states: AgentState[]): string {
  const tmuxMode = args.includes('--tmux');
  const session = args.filter((a) => !a.startsWith('--'))[0] ?? '';

  if (tmuxMode) {
    return formatTmuxStatus(states, session);
  }
  return formatPlainStatus(states, session);
}
