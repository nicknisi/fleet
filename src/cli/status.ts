import { AgentStatus, ACK_ALL_RANGE, compareStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';

export function formatAge(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - ts);
  if (delta < 5) return 'now';
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

export function formatStatusLine(states: AgentState[]): string {
  // The status line is for agents whose turn it is for you to act on: waiting on
  // a permission prompt (PERMIT), asking a question (QUESTION), or finished and
  // waiting on your next move (DONE/ready). Working and idle agents don't need
  // you, so they stay out of the bar.
  const visible: AgentStatus[] = [AgentStatus.PERMIT, AgentStatus.QUESTION, AgentStatus.DONE];
  const filtered = states.filter((s) => visible.includes(s.status));
  if (filtered.length === 0) return '';

  filtered.sort((a, b) => compareStatus(a.status, b.status));

  const entries = filtered.map((s) => {
    const display = STATUS_DISPLAY[s.status];
    return `#[range=user|${s.paneId}]#[fg=${display.color}]${display.icon} #[bold]${s.session}#[nobold] ${formatAge(s.ts)}#[norange]`;
  });

  // A "clear all" chip dismisses every ready agent at once. Only ready (DONE)
  // agents are dismissible, so the chip only appears when one is present.
  if (filtered.some((s) => s.status === AgentStatus.DONE)) {
    entries.push(`#[range=user|${ACK_ALL_RANGE}]#[fg=#6c7086]✕ clear#[norange]`);
  }

  return entries.join(' #[fg=#45475a]│ ');
}

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
  const statusLineMode = args.includes('--statusline');
  const session = args.filter((a) => !a.startsWith('--'))[0] ?? '';

  if (statusLineMode) {
    return formatStatusLine(states);
  }
  if (tmuxMode) {
    return formatTmuxStatus(states, session);
  }
  return formatPlainStatus(states, session);
}
