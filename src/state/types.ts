export const AgentStatus = {
  PERMIT: 'PERMIT',
  QUESTION: 'QUESTION',
  DONE: 'DONE',
  BUSY: 'BUSY',
  IDLE: 'IDLE',
  SHELL: 'SHELL',
  DOWN: 'DOWN',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

// Sentinel range name for the status-line "clear all" chip. Not a pane id — the
// CLI router (fleet switch / fleet ack) detects it and acknowledges every ready
// agent instead of acting on a single pane.
export const ACK_ALL_RANGE = '__ack_all__';

// Dashboard sort order, most-urgent first: a blocked tool (PERMIT) and a
// question (QUESTION) need you now; working agents come next so live work stays
// visible; then ready (finished, waiting on you); then idle and the rest.
const PRIORITY: Record<AgentStatus, number> = {
  [AgentStatus.PERMIT]: 0,
  [AgentStatus.QUESTION]: 1,
  [AgentStatus.BUSY]: 2,
  [AgentStatus.DONE]: 3,
  [AgentStatus.IDLE]: 4,
  [AgentStatus.SHELL]: 5,
  [AgentStatus.DOWN]: 6,
};

export function statusPriority(status: AgentStatus): number {
  return PRIORITY[status];
}

export function compareStatus(a: AgentStatus, b: AgentStatus): number {
  return PRIORITY[a] - PRIORITY[b];
}

// `color` is a tmux color name (not a hex value): it is consumed only by the
// tmux status line via `#[fg=...]`, where named colors resolve against the
// terminal's own palette so they stay readable on light and dark themes alike.
// The in-app TUI ignores this field and colors state via getStateColor()/the C
// palette instead.
export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; label: string; color: string }> = {
  [AgentStatus.PERMIT]: { icon: '⚠', label: 'waiting', color: 'yellow' },
  [AgentStatus.QUESTION]: { icon: '?', label: 'asking', color: 'magenta' },
  [AgentStatus.DONE]: { icon: '●', label: 'ready', color: 'green' },
  [AgentStatus.BUSY]: { icon: '◉', label: 'working', color: 'brightred' },
  [AgentStatus.IDLE]: { icon: '●', label: 'idle', color: 'blue' },
  [AgentStatus.SHELL]: { icon: '■', label: 'shell', color: 'brightblack' },
  [AgentStatus.DOWN]: { icon: '○', label: 'down', color: 'brightblack' },
};

export interface AgentState {
  paneId: string;
  paneNum: number;
  session: string;
  window: string;
  windowId: string;
  claudeName: string | null;
  customName: string | null; // user rename for this pane's session, or null
  status: AgentStatus;
  tool: string | null;
  project: string | null;
  branch: string | null;
  ports: number[];
  ts: number;
  agentType: string;
}

export function extractClaudeName(paneTitle: string): string | null {
  const trimmed = paneTitle.trim();
  if (!trimmed.startsWith('✳')) return null;
  const name = trimmed.slice(1).trim();
  return name.length > 0 ? name : null;
}

// The pane title fleet advertises via OSC 2 (tui/dashboard.ts paneTitle).
// Title-aware window renamers copy the focused pane's title into the window
// name, so a window ends up named after fleet itself whenever the fleet pane
// holds focus — that name describes fleet, not the agents sharing the window.
export const FLEET_PANE_TITLE = 'fleet';

// tmux target-style label (`session:window`). The window is dropped when it adds
// no information — empty, or auto-named after the session itself.
export function sessionLabel(state: AgentState): string {
  const label = windowLabel(state);
  return label === state.session ? state.session : `${state.session}:${label}`;
}

// Window-first label: the window name is what distinguishes agents; the
// session is the fallback when the window adds no information. A window named
// exactly after fleet's advertised pane title was named by a title-aware
// renamer reading the fleet pane, not this agent — the agent's project
// directory is the honest label there (and when the agent really is working
// in a repo named fleet, the basename shows "fleet" anyway).
export function windowLabel(state: AgentState): string {
  if (state.window.length === 0 || state.window === state.session) return state.session;
  if (state.window === FLEET_PANE_TITLE) {
    const project = state.project?.split('/').pop();
    return project && project.length > 0 ? project : state.session;
  }
  return state.window;
}

// Precedence for a row's primary label: user rename > Claude auto-name > session.
export function displayName(state: AgentState): string {
  return state.customName ?? state.claudeName ?? sessionLabel(state);
}

// Session-level display string (rename wins over the raw session name). Used by
// the dashboard's session column/header; window sub-labels are unaffected.
export function sessionDisplay(state: AgentState): string {
  return state.customName ?? state.session;
}

export interface HookStatus {
  state: string;
  pane: string;
  session: string;
  tool: string;
  ts: number;
  tmux_pid: number;
}

// HookStatus stays the pure on-disk wire shape (unchanged). ResolvedHookStatus is
// the in-memory record after we know which agent dir produced it: the owning
// agent name and its source dir ride WITH the data, so the read path never has to
// re-derive who authored a status. index.ts sets AgentState.agentType from
// `agent`, and reads the matching .events.jsonl from `statusDir`.
export interface ResolvedHookStatus extends HookStatus {
  agent: string; // registry name of the owning AgentDir -> AgentState.agentType
  statusDir: string; // the dir this file came from -> read the matching .events.jsonl
}

export interface EventEntry {
  event: string;
  ts: number;
  tool?: string;
  stop_reason?: string;
  background_tasks?: boolean;
  notification_type?: string;
}

// Scraper return — was: AgentStatus | null. `ruleId` names the match branch that
// fired (namespaced state.marker, e.g. 'permit.yn', 'idle.prompt') so the fusion
// trace can show *why* the scraper read what it did. null/null == no match.
export interface DetectResult {
  status: AgentStatus | null;
  ruleId: string | null;
}

// Fusion trace — one per pane per refresh, discarded by the hot loop. Records
// which layer authored the final state and why, for `fleet explain`.
export interface StateDecision {
  final: AgentStatus;
  candidates: { hook: AgentStatus | null; event: AgentStatus | null; scrape: AgentStatus | null };
  hookTs: number;
  eventTs: number | null;
  now: number;
  winner: 'hook' | 'event' | 'scrape' | 'default';
  reason: string; // human-readable why
  workingTimeoutFired: boolean;
  freshnessEvaluated: boolean; // MUST be false under live wiring — see engine notes
  scrapeRuleId: string | null;
}
