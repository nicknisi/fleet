import {
  AgentStatus,
  ACK_ALL_RANGE,
  compareStatus,
  formatAgeDelta,
  needsAttention,
  STATUS_DISPLAY,
  windowLabel,
  type AgentState,
} from '../state/types.ts';

export function formatAge(ts: number): string {
  return formatAgeDelta(Math.floor(Date.now() / 1000) - ts);
}

export function formatStatusLine(states: AgentState[]): string {
  // The status line is for agents whose turn it is for you to act on: waiting on
  // a permission prompt (PERMIT), asking a question (QUESTION), or finished and
  // waiting on your next move (DONE/ready). Working and idle agents don't need
  // you, so they stay out of the bar.
  const filtered = states.filter((s) => needsAttention(s.status));
  if (filtered.length === 0) return '';

  filtered.sort((a, b) => compareStatus(a.status, b.status));

  const entries = filtered.map((s) => {
    const display = STATUS_DISPLAY[s.status];
    // tmux re-expands format directives in #() output, so a window/session
    // name containing '#' must be escaped ('##') or it corrupts the row.
    const label = windowLabel(s).replace(/#/g, '##');
    return `#[range=user|${s.paneId}]#[fg=${display.color}]${display.icon} #[bold]${label}#[nobold] ${formatAge(s.ts)}#[norange]`;
  });

  // A "clear all" chip dismisses every ready agent at once. Only ready (DONE)
  // agents are dismissible, so the chip only appears when one is present.
  if (filtered.some((s) => s.status === AgentStatus.DONE)) {
    entries.push(`#[range=user|${ACK_ALL_RANGE}]#[fg=brightblack]✕ clear#[norange]`);
  }

  return entries.join(' #[fg=brightblack]│ ');
}

export function formatPlainStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return 'idle 0';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;
  const needsYouCount = sessionStates.filter((s) => needsAttention(s.status)).length;

  return `${mostUrgent} ${needsYouCount}`;
}

export function formatTmuxStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return '';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;

  if (!needsAttention(mostUrgent)) return '';

  const display = STATUS_DISPLAY[mostUrgent];
  return `#[fg=${display.color}] ${display.icon} `;
}

// Group agents by their tmux window id, reduce each window to its most-urgent
// status (mirroring formatTmuxStatus), and return per-window tmux arg lists
// (WITHOUT the leading "tmux") so the runner can batch them into one invocation
// with ";" separators. A window whose worst state needs you is tinted its color;
// every other present window is explicitly UNSET so a stale tint can't linger.
export function windowColorArgs(states: AgentState[]): string[][] {
  const byWindow = new Map<string, AgentState[]>();
  for (const s of states) {
    if (s.windowId.length === 0) continue; // old binary / parse miss — degrade to no tint
    const list = byWindow.get(s.windowId) ?? [];
    list.push(s);
    byWindow.set(s.windowId, list);
  }

  const args: string[][] = [];
  for (const [windowId, group] of byWindow) {
    group.sort((a, b) => compareStatus(a.status, b.status));
    const worst = group[0]!.status;
    if (needsAttention(worst)) {
      args.push(['set', '-w', '-t', windowId, '@fleet_state', STATUS_DISPLAY[worst].color]);
    } else {
      // Data shadow: a window whose agent just went idle/working MUST be unset
      // this same refresh, or a stale tint lingers. We enumerate every present
      // window and set-or-unset — the process is stateless, so we cannot
      // "remember" which we set last time.
      args.push(['set', '-w', '-u', '-t', windowId, '@fleet_state']);
    }
  }
  return args;
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
