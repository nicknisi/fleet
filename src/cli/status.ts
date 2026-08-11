import {
  AgentStatus,
  ACK_ALL_RANGE,
  SIDEBAR_RANGE,
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

// Leftmost chip, always rendered: toggles the fleet sidebar. Anchoring it at the
// left keeps it in one fixed spot as agent chips come and go — a click target
// that moves is a click target you miss — and it doubles as the only visible
// signal that the row is clickable at all.
//
// The button is prepended rather than joined, so no `│` separates it from the
// first agent chip: the divider is for telling agents apart, and the glyph is
// already visually distinct from them.
//
// It's padded on BOTH sides — the leading space keeps ☰ off the terminal edge
// (row 1 starts at column 0, so an unpadded glyph collides with the window
// border), the trailing one separates it from the first chip. Both sit INSIDE
// the range, so they double as click area: a bare glyph is a 1-cell target.
//
// Deliberately static: showing sidebar open/closed state would mean a list-panes
// call on every status redraw, and one fleet process per redraw is the budget
// this whole path is built around.
const SIDEBAR_BUTTON = `#[range=user|${SIDEBAR_RANGE}]#[fg=cyan] ☰ #[norange]`;

// These chips must keep reaching tmux as #() job output, never inlined into
// status-format as a literal: tmux strftime-expands the format string itself, so
// a literal `range=user|%42` registers as `42` (%4 is an unknown conversion) and
// every click resolves to the wrong target. Job output skips that pass.
export function formatStatusLine(states: AgentState[]): string {
  // The status line is for agents whose turn it is for you to act on: waiting on
  // a permission prompt (PERMIT), asking a question (QUESTION), or finished and
  // waiting on your next move (DONE/ready). Working and idle agents don't need
  // you, so they stay out of the bar.
  const filtered = states.filter((s) => needsAttention(s.status));
  filtered.sort((a, b) => compareStatus(a.status, b.status));

  const entries: string[] = [];

  for (const s of filtered) {
    const display = STATUS_DISPLAY[s.status];
    // tmux re-expands format directives in #() output, so a window/session
    // name containing '#' must be escaped ('##') or it corrupts the row.
    const label = windowLabel(s).replace(/#/g, '##');
    entries.push(
      `#[range=user|${s.paneId}]#[fg=${display.color}]${display.icon} #[bold]${label}#[nobold] ${formatAge(s.ts)}#[norange]`,
    );
  }

  // A "clear all" chip dismisses every ready agent at once. Only ready (DONE)
  // agents are dismissible, so the chip only appears when one is present.
  if (filtered.some((s) => s.status === AgentStatus.DONE)) {
    entries.push(`#[range=user|${ACK_ALL_RANGE}]#[fg=brightblack]✕ clear#[norange]`);
  }

  return SIDEBAR_BUTTON + entries.join(' #[fg=brightblack]│ ');
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

// Decide the `--statusline` segment, preferring a fresh cache so a live TUI's
// already-computed segment is reused without cold-booting Bun or re-reading
// agent state. Pure: the caller hands in whatever it read from the cache (null
// on miss) and a thunk for the live compute, and gets back the segment plus
// whether it was a cache hit. Split out so the short-circuit is testable without
// a real tmux/filesystem — the thin CLI shell in index.ts wires real I/O around
// it.
export function resolveStatusLineSegment(
  cached: string | null,
  computeLive: () => string,
): { segment: string; hit: boolean } {
  if (cached !== null) return { segment: cached, hit: true };
  return { segment: computeLive(), hit: false };
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
