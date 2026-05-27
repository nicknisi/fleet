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

const PRIORITY: Record<AgentStatus, number> = {
  [AgentStatus.PERMIT]: 0,
  [AgentStatus.QUESTION]: 1,
  [AgentStatus.DONE]: 2,
  [AgentStatus.BUSY]: 3,
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
  [AgentStatus.PERMIT]: { icon: '⚠', label: 'PERMIT', color: '#f9e2af' },
  [AgentStatus.QUESTION]: { icon: '?', label: 'QUESTION', color: '#cba6f7' },
  [AgentStatus.DONE]: { icon: '✓', label: 'DONE', color: '#a6e3a1' },
  [AgentStatus.BUSY]: { icon: '◉', label: 'BUSY', color: '#fab387' },
  [AgentStatus.IDLE]: { icon: '●', label: 'IDLE', color: '#89b4fa' },
  [AgentStatus.SHELL]: { icon: '■', label: 'SHELL', color: '#6c7086' },
  [AgentStatus.DOWN]: { icon: '○', label: 'DOWN', color: '#45475a' },
};

export interface AgentState {
  paneId: string;
  paneNum: number;
  session: string;
  status: AgentStatus;
  tool: string | null;
  project: string | null;
  branch: string | null;
  ports: number[];
  ts: number;
  agentType: string;
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
