import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import type { TuiApp } from './app.ts';

export function renderHeader(app: TuiApp, cols: number): string {
  const s = app.summary();
  const parts: string[] = [`${C.bold}fleet${C.reset}`];
  parts.push(`  ${C.gray}${s.total} agents${C.reset}`);
  if (s.permit > 0) parts.push(`  ${C.permit}${s.permit} permit${C.reset}`);
  if (s.question > 0) parts.push(`  ${C.question}${s.question} question${C.reset}`);
  if (s.done > 0) parts.push(`  ${C.done}${s.done} done${C.reset}`);
  return truncateAnsi(parts.join(''), cols);
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const visible = app.visibleStates();
  const lines: string[] = [];

  const header = `${C.gray}  ${'ST'.padEnd(4)}${'SESSION'.padEnd(17)}${'PROJECT'.padEnd(Math.max(10, cols - 47))}${'BRANCH'.padEnd(16)}${'AGE'.padEnd(6)}${C.reset}`;
  lines.push(header);
  lines.push(`${C.gray}${'─'.repeat(Math.min(cols, 75))}${C.reset}`);

  if (visible.length === 0) {
    lines.push(`${C.gray}  No agents found${C.reset}`);
    return lines;
  }

  const scrollOffset = calculateScroll(app.selectedIndex, maxRows - 2, visible.length);

  for (let i = scrollOffset; i < visible.length && lines.length < maxRows; i++) {
    const state = visible[i]!;
    const selected = i === app.selectedIndex;
    lines.push(formatSessionRow(state, cols, selected));
  }

  return lines;
}

function formatSessionRow(state: AgentState, cols: number, selected: boolean): string {
  const display = STATUS_DISPLAY[state.status];
  const stateColor = getStateColor(state.status);
  const age = formatAge(state.ts);
  const project = state.project ?? '';
  const branch = state.branch ?? '—';

  const prefix = selected ? `${C.bold}> ` : '  ';
  const projectW = Math.max(10, cols - 47);

  return `${prefix}${stateColor}${display.icon.padEnd(2)}${C.reset}  ${selected ? C.bold : ''}${state.session.padEnd(15)}${C.reset}${C.gray}${truncate(project, projectW).padEnd(projectW)}${truncate(branch, 14).padEnd(16)}${age.padEnd(6)}${C.reset}`;
}

function getStateColor(status: AgentStatus): string {
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

function formatAge(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const secs = Math.max(0, now - ts);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return '';
  return value.slice(0, maxWidth - 1) + '…';
}

function calculateScroll(selected: number, viewHeight: number, total: number): number {
  if (total <= viewHeight) return 0;
  const half = Math.floor(viewHeight / 2);
  if (selected <= half) return 0;
  if (selected >= total - half) return Math.max(0, total - viewHeight);
  return selected - half;
}

export function renderFooter(app: TuiApp, cols: number): string {
  const filter = app.getFilter();
  if (filter.length > 0) {
    return truncateAnsi(`${C.cyan}/${filter}${C.reset} ${C.gray}· esc clear${C.reset}`, cols);
  }
  return truncateAnsi(
    `${C.gray}↑↓ navigate  enter switch  / filter  p preview  s send  n next  ? help${C.reset}`,
    cols,
  );
}
