import { C } from '../terminal/colors.ts';
import { padAnsi, truncateAnsi, truncateWidth, visibleLength } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, windowLabel, type AgentState } from '../state/types.ts';
import { TuiMode, type DashboardRow, type TuiApp } from './app.ts';

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
  if (s.permit > 0) badges.push(`${C.permit}${s.permit} waiting${C.reset}`);
  if (s.question > 0) badges.push(`${C.question}${s.question} asking${C.reset}`);
  if (s.done > 0) badges.push(`${C.done}${s.done} ready${C.reset}`);
  if (s.busy > 0) badges.push(`${C.busy}${s.busy} working${C.reset}`);

  const agentCount = s.total - app.shellCount();
  const title = ` ${C.bold}${logo()}${C.reset} ${C.gray}${BOX_H} ${agentCount} agents · ${getQuip()}${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join('  ')}` : '';
  return [truncateAnsi(`${C.gray}┌${BOX_H}${C.reset}${title}${badgeStr}`, cols)];
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const rows = app.dashboardRows();
  const lines: string[] = [];

  if (rows.length === 0) {
    lines.push('');
    if (app.tmuxDown) {
      lines.push(`${C.permit}  ⚠ tmux isn't running${C.reset}`);
      lines.push(`${C.gray}  fleet reads agents from tmux panes — start tmux, then re-run fleet${C.reset}`);
    } else if (app.hooksMissing) {
      lines.push(`${C.question}  ? no agent hooks found${C.reset}`);
      lines.push(
        `${C.gray}  run ${C.reset}fleet install${C.gray} to wire Claude Code hooks, then ${C.reset}fleet doctor${C.gray} to verify${C.reset}`,
      );
    } else if (app.isFiltering()) {
      lines.push(`${C.gray}  no agents match "${app.getFilter()}"${C.reset}`);
    } else {
      lines.push(`${C.idle}  ● all quiet${C.reset}`);
      lines.push(`${C.gray}  start claude in any tmux pane and it appears here${C.reset}`);
    }
    return lines;
  }

  const widths = computeColumnWidths(rows, cols);
  const scrollOffset = calculateScroll(app.selectedRowIndex(), maxRows, rows.length);
  const selectedPane = app.selectedState()?.paneId ?? null;

  for (let i = scrollOffset; i < rows.length && lines.length < maxRows; i++) {
    const row = rows[i]!;
    if (row.kind === 'header') {
      lines.push(formatHeaderRow(row, cols));
    } else {
      lines.push(formatAgentRow(row, widths, cols, row.state.paneId === selectedPane));
    }
  }

  return lines;
}

export interface ColumnWidths {
  name: number;
  detail: number;
  branch: number;
}

// Per-row visible cells: sel(1) sp icon(1) sp name detail sp branch sp age(4).
// The name column is sized to its content (never truncated first); the detail
// column flexes with an 8-cell floor; below that the branch column drops
// entirely; only then does the name give way.
export function computeColumnWidths(rows: DashboardRow[], cols: number): ColumnWidths {
  let name = 0;
  for (const row of rows) {
    if (row.kind === 'agent') name = Math.max(name, visibleLength(nameCell(row)));
  }

  let branch = 12;
  let detail = cols - 11 - name - branch;
  if (detail < 8) {
    branch = 0;
    detail = cols - 9 - name;
  }
  if (detail < 8) {
    detail = 8;
    name = Math.max(1, cols - 9 - detail);
  }
  return { name, detail, branch };
}

function nameCell(row: Extract<DashboardRow, { kind: 'agent' }>): string {
  const label = windowLabel(row.state);
  if (row.grouped) return `  ${label}`;
  return label === row.state.session ? row.state.session : `${row.state.session} · ${label}`;
}

function formatHeaderRow(row: Extract<DashboardRow, { kind: 'header' }>, cols: number): string {
  const display = STATUS_DISPLAY[row.aggregate];
  const color = getStateColor(row.aggregate);
  const line = `  ${color}${display.icon}${C.reset} ${C.bold}${row.session}${C.reset} ${C.dim}· ${row.count} agents${C.reset}`;
  return truncateAnsi(line, cols);
}

function formatAgentRow(
  row: Extract<DashboardRow, { kind: 'agent' }>,
  widths: ColumnWidths,
  cols: number,
  selected: boolean,
): string {
  const state = row.state;
  const display = STATUS_DISPLAY[state.status];
  const stColor = getStateColor(state.status);

  const sel = selected ? `${stColor}▌${C.reset}` : ' ';

  const nameColor = selected ? C.bold : '';
  const name = padAnsi(truncateWidth(nameCell(row), widths.name), widths.name);

  let detail = '';
  if (state.claudeName) {
    detail = state.claudeName;
  } else {
    detail = (state.project ?? '').replace(/^~\/Developer\//, '');
  }

  const branch = state.branch ?? '';
  const branchColor = branch && branch !== 'main' && branch !== 'master' ? C.purple : C.gray;
  const branchPart =
    widths.branch > 0 ? ` ${branchColor}${padAnsi(truncateWidth(branch, widths.branch), widths.branch)}${C.reset}` : '';

  const age = formatAge(state.ts);
  const ageColor = getAgeColor(state.ts);

  const portStr = state.ports.length > 0 ? ` ${C.cyan}⌁${state.ports[0]}${C.reset}` : '';

  const detailColor = state.claudeName ? C.dim : C.gray;
  const line = `${sel} ${stColor}${display.icon}${C.reset} ${nameColor}${name}${C.reset}${detailColor}${padAnsi(truncateWidth(detail, widths.detail), widths.detail)}${C.reset}${branchPart} ${ageColor}${age.padEnd(4)}${C.reset}${portStr}`;

  return truncateAnsi(line, cols);
}

// Map a clicked session-list line (0 = first rendered line) back to the agent
// on that line, accounting for scroll and header rows. Header lines map to null.
export function stateAtLine(app: TuiApp, lineIdx: number, maxRows: number): AgentState | null {
  const rows = app.dashboardRows();
  const scrollOffset = calculateScroll(app.selectedRowIndex(), maxRows, rows.length);
  const row = rows[scrollOffset + lineIdx];
  return row !== undefined && row.kind === 'agent' ? row.state : null;
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
    `${C.permit}⚠ ${C.gray}waiting${C.reset}`,
    `${C.question}? ${C.gray}asking${C.reset}`,
    `${C.busy}◉ ${C.gray}working${C.reset}`,
    `${C.done}● ${C.gray}ready${C.reset}`,
    `${C.idle}● ${C.gray}idle${C.reset}`,
  ];
  lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${legend.join('  ')}`, cols));

  if (app.mode === TuiMode.PASSTHROUGH) {
    lines.push(
      truncateAnsi(
        `${C.gray}${BOX_H}${C.reset} ${C.cyan}● LIVE${C.reset} ${C.gray}— keystrokes forwarded to pane${C.reset}  ${chip('Esc')} ${C.gray}exit${C.reset}`,
        cols,
      ),
    );
  } else if (app.isFiltering()) {
    lines.push(
      truncateAnsi(
        `${C.gray}${BOX_H}${C.reset} ${C.cyan}/${app.getFilter()}${C.reset}█ ${C.gray}${BOX_H} ${C.reset}${chip('Esc')} ${C.gray}clear${C.reset}`,
        cols,
      ),
    );
  } else if (app.mode === TuiMode.PREVIEW) {
    const selected = app.selectedState();
    const hints = [`${chip('↑↓')} ${C.gray}nav${C.reset}`, `${chip('i')} ${C.gray}passthrough${C.reset}`];
    if (selected?.status === AgentStatus.PERMIT) {
      hints.push(`${chip('y')} ${C.gray}approve${C.reset}`);
      hints.push(`${chip('n')} ${C.gray}deny${C.reset}`);
    } else {
      hints.push(`${chip('s')} ${C.gray}send${C.reset}`);
      hints.push(`${chip('n')} ${C.gray}next${C.reset}`);
    }
    hints.push(`${chip('p')} ${C.gray}close${C.reset}`);
    hints.push(`${chip('?')} ${C.gray}help${C.reset}`);
    lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols));
  } else {
    const hints = [
      `${chip('↑↓')} ${C.gray}nav${C.reset}`,
      `${chip('⏎')} ${C.gray}switch${C.reset}`,
      `${chip('/')} ${C.gray}filter${C.reset}`,
      `${chip('p')} ${C.gray}preview${C.reset}`,
      `${chip('s')} ${C.gray}send${C.reset}`,
      `${chip('n')} ${C.gray}next${C.reset}`,
      `${chip('x')} ${C.gray}kill${C.reset}`,
      `${chip('?')} ${C.gray}help${C.reset}`,
    ];
    lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols));
  }

  return lines;
}

function chip(key: string): string {
  return `${C.dim}[${C.reset}${C.bold}${key}${C.reset}${C.dim}]${C.reset}`;
}
