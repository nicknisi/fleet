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

export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; label: string; color: string }> = {
  [AgentStatus.PERMIT]: { icon: '⚠', label: 'waiting', color: '#f9e2af' },
  [AgentStatus.QUESTION]: { icon: '?', label: 'asking', color: '#cba6f7' },
  [AgentStatus.DONE]: { icon: '●', label: 'ready', color: '#a6e3a1' },
  [AgentStatus.BUSY]: { icon: '◉', label: 'working', color: '#fab387' },
  [AgentStatus.IDLE]: { icon: '●', label: 'idle', color: '#89b4fa' },
  [AgentStatus.SHELL]: { icon: '■', label: 'shell', color: '#6c7086' },
  [AgentStatus.DOWN]: { icon: '○', label: 'down', color: '#45475a' },
};

export interface AgentState {
  paneId: string;
  paneNum: number;
  session: string;
  window: string;
  claudeName: string | null;
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

// tmux target-style label (`session:window`). The window is dropped when it adds
// no information — empty, or auto-named after the session itself.
export function sessionLabel(state: AgentState): string {
  if (state.window.length === 0 || state.window === state.session) return state.session;
  return `${state.session}:${state.window}`;
}

// Window-first label: the window name is what distinguishes agents; the
// session is the fallback when the window adds no information.
export function windowLabel(state: AgentState): string {
  if (state.window.length === 0 || state.window === state.session) return state.session;
  return state.window;
}

export function displayName(state: AgentState): string {
  return state.claudeName ?? sessionLabel(state);
}

export interface HookStatus {
  state: string;
  pane: string;
  session: string;
  tool: string;
  ts: number;
  tmux_pid: number;
}

export interface EventEntry {
  event: string;
  ts: number;
  tool?: string;
  stop_reason?: string;
  background_tasks?: boolean;
  notification_type?: string;
}
