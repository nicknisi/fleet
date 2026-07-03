import { C } from '../../terminal/colors.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../../state/types.ts';

// One entry per rendered line: states[i] is the agent on lines[i], or null for
// chrome lines (headers, separators, indicators). Render and hit-testing both
// consume this, so a click can never disagree with what was drawn.
export interface LayoutLines {
  lines: string[];
  states: (AgentState | null)[];
}

export function getStateColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.PERMIT:
      return C.permit;
    case AgentStatus.QUESTION:
      return C.question;
    case AgentStatus.DONE:
      return C.done;
    case AgentStatus.BUSY:
      return C.busy;
    case AgentStatus.IDLE:
      return C.idle;
    case AgentStatus.SHELL:
      return C.shell;
    case AgentStatus.DOWN:
      return C.down;
  }
}

// BUSY breathes: alternate dim/normal each fast tick. Everything else is steady.
export function stateIcon(status: AgentStatus, pulsePhase: boolean): string {
  const icon = STATUS_DISPLAY[status].icon;
  const color = getStateColor(status);
  if (status === AgentStatus.BUSY && pulsePhase) return `${C.dim}${color}${icon}${C.reset}`;
  return `${color}${icon}${C.reset}`;
}

export function getAgeColor(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 30) return C.green;
  if (secs < 300) return C.gray;
  return C.down;
}

export function formatAge(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function calculateScroll(selected: number, viewHeight: number, total: number): number {
  if (total <= viewHeight) return 0;
  const half = Math.floor(viewHeight / 2);
  if (selected <= half) return 0;
  if (selected >= total - half) return Math.max(0, total - viewHeight);
  return selected - half;
}

// Window `all` to maxRows around selectedLine, adding ↑/↓ indicator lines when
// content is clipped. Indicator lines carry a null state.
export function windowLines(all: LayoutLines, selectedLine: number, maxRows: number): LayoutLines {
  const total = all.lines.length;
  if (total <= maxRows) return all;

  // Indicator visibility depends on the offset, which depends on how many
  // rows the indicators consume — a fixed point. Offset is monotone
  // non-decreasing as the window shrinks, so this stabilizes in ≤3 rounds.
  let showTop = false;
  let showBot = false;
  let inner = maxRows;
  let offset = 0;
  for (let round = 0; round < 4; round++) {
    inner = maxRows - (showTop ? 1 : 0) - (showBot ? 1 : 0);
    offset = calculateScroll(selectedLine, inner, total);
    const nextTop = offset > 0;
    const nextBot = offset + inner < total;
    if (nextTop === showTop && nextBot === showBot) break;
    showTop = nextTop;
    showBot = nextBot;
  }

  const lines: string[] = [];
  const states: (AgentState | null)[] = [];
  if (showTop) {
    lines.push(`${C.gray}  ↑ ${offset} more${C.reset}`);
    states.push(null);
  }
  lines.push(...all.lines.slice(offset, offset + inner));
  states.push(...all.states.slice(offset, offset + inner));
  if (showBot) {
    lines.push(`${C.gray}  ↓ ${total - offset - inner} more${C.reset}`);
    states.push(null);
  }
  return { lines, states };
}
