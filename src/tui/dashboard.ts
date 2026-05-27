import { C } from '../terminal/colors.ts';
import { truncateAnsi, visibleLength } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import type { TuiApp } from './app.ts';

const BOX_H = '─';
const BOX_TL = '┌';

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

function pickQuip(): string {
  return QUIPS[Math.floor(Math.random() * QUIPS.length)]!;
}

let cachedQuip: string | null = null;
function getQuip(): string {
  if (!cachedQuip) cachedQuip = pickQuip();
  return cachedQuip;
}

export function renderHeader(app: TuiApp, cols: number): string[] {
  const s = app.summary();
  const lines: string[] = [];

  // Title bar with box-drawing
  const badges: string[] = [];
  if (s.permit > 0) badges.push(`${C.permit}${s.permit} permit${C.reset}`);
  if (s.question > 0) badges.push(`${C.question}${s.question} question${C.reset}`);
  if (s.done > 0) badges.push(`${C.done}${s.done} done${C.reset}`);
  if (s.busy > 0) badges.push(`${C.busy}${s.busy} busy${C.reset}`);

  const title = ` ${C.bold}fleet${C.reset} ${C.gray}${BOX_H} ${s.total} agents · ${getQuip()}${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join('  ')}` : '';
  lines.push(truncateAnsi(`${C.gray}${BOX_TL}${BOX_H}${C.reset}${title}${badgeStr}`, cols));

  return lines;
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const visible = app.visibleStates();
  const lines: string[] = [];

  if (visible.length === 0) {
    lines.push('');
    lines.push(`${C.gray}  No agents found${C.reset}`);
    return lines;
  }

  // Group by state category for separators
  const groups = groupByCategory(visible);
  const scrollOffset = calculateScroll(app.selectedIndex, maxRows, visible.length);
  let globalIdx = 0;

  for (const group of groups) {
    for (const state of group.states) {
      if (globalIdx >= scrollOffset && lines.length < maxRows) {
        // Insert group separator at first visible item of a new group
        if (state === group.states[0] && globalIdx >= scrollOffset && lines.length > 0) {
          if (lines.length < maxRows) {
            lines.push(`${C.gray}  ${BOX_H.repeat(Math.min(cols - 4, 70))}${C.reset}`);
          }
        }
        const selected = globalIdx === app.selectedIndex;
        lines.push(formatSessionRow(state, cols, selected));
      }
      globalIdx++;
    }
  }

  return lines;
}

interface StateGroup {
  category: string;
  states: AgentState[];
}

function groupByCategory(states: AgentState[]): StateGroup[] {
  const attention: AgentState[] = [];
  const working: AgentState[] = [];
  const passive: AgentState[] = [];

  for (const s of states) {
    switch (s.status) {
      case AgentStatus.PERMIT:
      case AgentStatus.QUESTION:
      case AgentStatus.DONE:
        attention.push(s);
        break;
      case AgentStatus.BUSY:
        working.push(s);
        break;
      default:
        passive.push(s);
        break;
    }
  }

  const groups: StateGroup[] = [];
  if (attention.length > 0) groups.push({ category: 'attention', states: attention });
  if (working.length > 0) groups.push({ category: 'working', states: working });
  if (passive.length > 0) groups.push({ category: 'passive', states: passive });
  return groups;
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

  // Layout: sel icon session project branch age ports
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

  // Legend row
  const legend = [
    `${C.permit}⚠ ${C.reset}${C.gray}permit${C.reset}`,
    `${C.question}? ${C.reset}${C.gray}question${C.reset}`,
    `${C.done}✓ ${C.reset}${C.gray}done${C.reset}`,
    `${C.busy}◉ ${C.reset}${C.gray}busy${C.reset}`,
    `${C.idle}● ${C.reset}${C.gray}idle${C.reset}`,
    `${C.shell}■ ${C.reset}${C.gray}shell${C.reset}`,
  ];
  lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${legend.join('  ')}`, cols));

  // Keybindings row
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
