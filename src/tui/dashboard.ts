import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { TuiMode, type TuiApp } from './app.ts';
import { buildTableLines } from './layouts/table.ts';
import { buildCardLines } from './layouts/cards.ts';
import { pickLayout } from './layouts/index.ts';
import { windowLines, type LayoutLines } from './layouts/shared.ts';

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
  const agentCount = s.total - app.shellCount();
  const idle = agentCount - s.permit - s.question - s.done - s.busy;

  const badges: string[] = [];
  const needsYou = s.permit + s.question;
  if (needsYou > 0) badges.push(`${C.permit}${C.bold}${needsYou} need you${C.reset}`);
  if (s.busy > 0) badges.push(`${C.busy}${s.busy} working${C.reset}`);
  if (s.done > 0) badges.push(`${C.done}${s.done} ready${C.reset}`);
  if (idle > 0) badges.push(`${C.gray}${idle} idle${C.reset}`);

  const title = ` ${C.bold}${logo()}${C.reset} ${C.gray}${BOX_H} ${agentCount} agents · ${getQuip()}${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join(` ${C.dim}·${C.reset} `)}` : '';
  return [truncateAnsi(`${C.gray}┌${BOX_H}${C.reset}${title}${badgeStr}`, cols)];
}

function buildLines(app: TuiApp, cols: number): LayoutLines {
  return pickLayout(cols) === 'cards' ? buildCardLines(app, cols) : buildTableLines(app, cols);
}

// Line index (chrome lines included) of the selected agent within built lines.
function selectedLineIndex(app: TuiApp, cols: number): number {
  const selected = app.selectedState();
  if (!selected) return 0;
  const built = buildLines(app, cols);
  return Math.max(
    0,
    built.states.findIndex((s) => s?.paneId === selected.paneId),
  );
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const rows = app.dashboardRows();

  if (rows.length === 0) {
    const lines: string[] = [];
    lines.push('');
    if (app.tmuxDown) {
      lines.push(truncateAnsi(`${C.permit}  ⚠ tmux isn't running${C.reset}`, cols));
      lines.push(
        truncateAnsi(`${C.gray}  fleet reads agents from tmux panes — start tmux, then re-run fleet${C.reset}`, cols),
      );
    } else if (app.hooksMissing) {
      lines.push(truncateAnsi(`${C.question}  ? no agent hooks found${C.reset}`, cols));
      lines.push(
        truncateAnsi(
          `${C.gray}  run ${C.reset}fleet install${C.gray} to wire Claude Code hooks, then ${C.reset}fleet doctor${C.gray} to verify${C.reset}`,
          cols,
        ),
      );
    } else if (app.isFiltering()) {
      lines.push(truncateAnsi(`${C.gray}  no agents match "${app.getFilter()}"${C.reset}`, cols));
    } else {
      lines.push(truncateAnsi(`${C.idle}  ● all quiet${C.reset}`, cols));
      lines.push(truncateAnsi(`${C.gray}  start claude in any tmux pane and it appears here${C.reset}`, cols));
    }
    return lines;
  }

  return windowLines(buildLines(app, cols), selectedLineIndex(app, cols), maxRows).lines;
}

// Map a clicked session-list line (0 = first rendered line) back to the agent
// on that line, accounting for scroll, header rows, and scroll indicators.
// Chrome lines (headers, indicators) map to null.
export function stateAtLine(app: TuiApp, lineIdx: number, maxRows: number, cols: number): AgentState | null {
  const windowed = windowLines(buildLines(app, cols), selectedLineIndex(app, cols), maxRows);
  return windowed.states[lineIdx] ?? null;
}

export function renderFooter(app: TuiApp, cols: number): string[] {
  if (pickLayout(cols) === 'cards') {
    const hints = [
      `${chip('⏎')} ${C.gray}switch${C.reset}`,
      `${chip('?')} ${C.gray}help${C.reset}`,
      `${chip('q')} ${C.gray}quit${C.reset}`,
    ];
    return [truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols)];
  }

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

export { computeColumnWidths, type ColumnWidths } from './layouts/table.ts';
export { calculateScroll, formatAge, getAgeColor, getStateColor } from './layouts/shared.ts';
