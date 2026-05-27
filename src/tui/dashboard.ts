import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import type { TuiApp } from './app.ts';

const BOX_H = '─';

const QUIPS = [
  'herding agents',
  'cat wrangling',
  'vibes: immaculate',
  'all hands on deck',
  'in the trenches',
  'agents assemble',
  'mission control',
  'fleet HQ',
  'the war room',
  'pane management',
];

let cachedQuip: string | null = null;
function getQuip(): string {
  if (!cachedQuip) cachedQuip = QUIPS[Math.floor(Math.random() * QUIPS.length)]!;
  return cachedQuip;
}

function logo(): string {
  return `${C.permit}f${C.question}l${C.done}e${C.busy}e${C.idle}t${C.reset}`;
}

export function renderHeader(app: TuiApp, cols: number): string[] {
  const s = app.summary();

  const badges: string[] = [];
  if (s.permit > 0) badges.push(`${C.permit}${s.permit} permit${C.reset}`);
  if (s.question > 0) badges.push(`${C.question}${s.question} question${C.reset}`);
  if (s.done > 0) badges.push(`${C.done}${s.done} done${C.reset}`);
  if (s.busy > 0) badges.push(`${C.busy}${s.busy} busy${C.reset}`);

  const agentCount = s.total - app.shellCount();
  const title = ` ${C.bold}${logo()}${C.reset} ${C.gray}${BOX_H} ${agentCount} agents · ${getQuip()}${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join('  ')}` : '';
  return [truncateAnsi(`${C.gray}┌${BOX_H}${C.reset}${title}${badgeStr}`, cols)];
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const visible = app.visibleStates();
  const lines: string[] = [];

  if (visible.length === 0) {
    lines.push('');
    lines.push(`${C.gray}  No agents found${C.reset}`);
    return lines;
  }

  const scrollOffset = calculateScroll(app.selectedIndex, maxRows, visible.length);

  for (let i = scrollOffset; i < visible.length && lines.length < maxRows; i++) {
    const selected = i === app.selectedIndex;
    lines.push(formatSessionRow(visible[i]!, cols, selected));
  }

  return lines;
}

function formatSessionRow(state: AgentState, cols: number, selected: boolean): string {
  const display = STATUS_DISPLAY[state.status];
  const stColor = getStateColor(state.status);

  const sel = selected ? `${stColor}▌${C.reset}` : ' ';

  const nameColor = selected ? C.bold : '';
  const name = state.session.padEnd(15);

  let project = state.project ?? '';
  project = project.replace(/^~\/Developer\//, '');

  const branch = state.branch ?? '';
  const branchColor = branch && branch !== 'main' && branch !== 'master' ? C.purple : C.gray;

  const age = formatAge(state.ts);
  const ageColor = getAgeColor(state.ts);

  const portStr = state.ports.length > 0 ? ` ${C.cyan}⌁${state.ports[0]}${C.reset}` : '';

  const fixedW = 3 + 15 + 1 + 14 + 5;
  const projectW = Math.max(8, cols - fixedW);
  const row = `${sel} ${stColor}${display.icon}${C.reset} ${nameColor}${name}${C.reset}${C.gray}${truncate(project, projectW).padEnd(projectW)}${C.reset} ${branchColor}${truncate(branch, 12).padEnd(12)}${C.reset} ${ageColor}${age.padEnd(4)}${C.reset}${portStr}`;

  return truncateAnsi(row, cols);
}

function getStateColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.PERMIT: return C.permit;
    case AgentStatus.QUESTION: return C.question;
    case AgentStatus.DONE: return C.done;
    case AgentStatus.BUSY: return C.busy;
    case AgentStatus.IDLE: return C.idle;
    case AgentStatus.SHELL: return C.shell;
    case AgentStatus.DOWN: return C.down;
  }
}

function getAgeColor(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 30) return C.green;
  if (secs < 300) return C.gray;
  return C.down;
}

function formatAge(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
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

export function renderFooter(app: TuiApp, cols: number): string[] {
  const lines: string[] = [];

  const legend = [
    `${C.permit}⚠ ${C.gray}permit${C.reset}`,
    `${C.question}? ${C.gray}question${C.reset}`,
    `${C.done}✓ ${C.gray}done${C.reset}`,
    `${C.busy}◉ ${C.gray}busy${C.reset}`,
    `${C.idle}● ${C.gray}idle${C.reset}`,
  ];
  lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${legend.join('  ')}`, cols));

  if (app.isFiltering()) {
    lines.push(truncateAnsi(
      `${C.gray}${BOX_H}${C.reset} ${C.cyan}/${app.getFilter()}${C.reset}█ ${C.gray}${BOX_H} ${C.reset}${chip('Esc')} ${C.gray}clear${C.reset}`,
      cols,
    ));
  } else {
    const hints = [
      `${chip('↑↓')} ${C.gray}nav${C.reset}`,
      `${chip('⏎')} ${C.gray}switch${C.reset}`,
      `${chip('/')} ${C.gray}filter${C.reset}`,
      `${chip('p')} ${C.gray}preview${C.reset}`,
      `${chip('s')} ${C.gray}send${C.reset}`,
      `${chip('n')} ${C.gray}next${C.reset}`,
      `${chip('?')} ${C.gray}help${C.reset}`,
    ];
    lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols));
  }

  return lines;
}

function chip(key: string): string {
  return `${C.dim}[${C.reset}${C.bold}${key}${C.reset}${C.dim}]${C.reset}`;
}
