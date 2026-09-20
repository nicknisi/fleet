import { C } from '../terminal/colors.ts';
import { truncateAnsi } from '../terminal/ansi.ts';
import { AgentStatus, FLEET_PANE_TITLE, type AgentState } from '../state/types.ts';
import { TuiMode, type TuiApp } from './app.ts';
import { buildTableLines } from './layouts/table.ts';
import { buildCardLines } from './layouts/cards.ts';
import { pickLayout } from './layouts/index.ts';
import { chip, stateIcon, windowLines, type LayoutLines } from './layouts/shared.ts';

const BOX_H = '─';

function logo(): string {
  return `${C.permit}f${C.question}l${C.done}e${C.busy}e${C.idle}t${C.reset}`;
}

// The pane title fleet advertises via OSC 2 — surfaced as the tmux window
// name by title-aware automatic-rename setups. Plain text only (no ANSI
// colors: tmux renders window names literally). Must never start with ✳,
// which extractClaudeName treats as a Claude agent marker.
//
// TODO(nicknisi): decide what the window name says in each state — e.g.
// all quiet vs. "fleet ◉2" (busy) vs. "fleet ⚠1" (needs you). Inputs would
// be app.summary() / app.shellCount() (add parameters back then). Keep it
// short — it lives in the tmux status bar next to your other window names.
export function paneTitle(): string {
  return FLEET_PANE_TITLE;
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

  if (pickLayout(cols) === 'cards') {
    const attention = [`${C.permit}${needsYou} need you${C.reset}`, `${C.done}${s.done} ready${C.reset}`].join(
      ` ${C.gray}·${C.reset} `,
    );
    const activity = `${stateIcon(AgentStatus.BUSY, app.spinnerFrame)} ${s.busy} working  ${C.idle}○ ${idle} idle${C.reset}`;
    return [truncateAnsi(`${C.bold}fleet${C.reset}  ${attention}`, cols), truncateAnsi(activity, cols)];
  }

  const title = ` ${C.bold}${logo()}${C.reset} ${C.gray}${BOX_H} ${agentCount} agents${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join(` ${C.dim}·${C.reset} `)}` : '';
  return [truncateAnsi(`${C.gray}┌${BOX_H}${C.reset}${title}${badgeStr}`, cols)];
}

function buildLines(app: TuiApp, cols: number): LayoutLines {
  return pickLayout(cols) === 'cards' ? buildCardLines(app, cols) : buildTableLines(app, cols);
}

// Line index (chrome lines included) of the selected agent within `built` —
// takes the already-built lines so callers never build the layout twice.
function selectedLineIndex(app: TuiApp, built: LayoutLines): number {
  const selected = app.selectedState();
  if (!selected) return 0;
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
    } else if (app.getFilter().length > 0) {
      lines.push(truncateAnsi(`${C.gray}  no agents match "${app.getFilter()}"${C.reset}`, cols));
    } else {
      lines.push(truncateAnsi(`${C.idle}  ● all quiet${C.reset}`, cols));
      lines.push(truncateAnsi(`${C.gray}  start claude in any tmux pane and it appears here${C.reset}`, cols));
    }
    return lines;
  }

  const built = buildLines(app, cols);
  return windowLines(built, selectedLineIndex(app, built), maxRows).lines;
}

// Map a clicked session-list line (0 = first rendered line) back to the agent
// on that line, accounting for scroll, header rows, and scroll indicators.
// Chrome lines (headers, indicators) map to null.
export function stateAtLine(app: TuiApp, lineIdx: number, maxRows: number, cols: number): AgentState | null {
  const built = buildLines(app, cols);
  const windowed = windowLines(built, selectedLineIndex(app, built), maxRows);
  return windowed.states[lineIdx] ?? null;
}

export function renderFooter(app: TuiApp, cols: number): string[] {
  // Input mode is safety-critical chrome, even in a 34-column sidebar.
  if (app.mode === TuiMode.SEND || app.mode === TuiMode.RENAME || app.mode === TuiMode.CONFIRM_KILL) {
    const confirm =
      app.mode === TuiMode.CONFIRM_KILL
        ? `${chip('y')} confirm`
        : `${chip('Enter')} ${app.mode === TuiMode.SEND ? 'send' : 'save'}`;
    return [truncateAnsi(`${confirm}  ${chip('Esc')} cancel`, cols)];
  }
  if (app.mode === TuiMode.PASSTHROUGH) {
    return [truncateAnsi(`${C.cyan}LIVE → ${app.actionTarget?.paneId ?? '?'}${C.reset}  ${chip('Esc')} exit`, cols)];
  }
  if (app.isFiltering() || app.getFilter().length > 0) {
    const hint = ` ${chip('Esc')} clear`;
    const query = `${C.cyan}/${app.getFilter()}${C.reset}${app.isFiltering() ? '█' : ''}`;
    return [truncateAnsi(truncateAnsi(query, Math.max(1, cols - 13)) + hint, cols)];
  }
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
    `${C.busy}⠋ ${C.gray}working${C.reset}`,
    `${C.done}● ${C.gray}ready${C.reset}`,
    `${C.idle}○ ${C.gray}idle${C.reset}`,
  ];
  lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${legend.join('  ')}`, cols));

  if (app.mode === TuiMode.PREVIEW) {
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
      `${chip('d')} ${C.gray}why${C.reset}`,
      `${chip('?')} ${C.gray}help${C.reset}`,
    ];
    lines.push(truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols));
  }

  return lines;
}

export { computeColumnWidths, type ColumnWidths } from './layouts/table.ts';
export { calculateScroll, formatAge, getAgeColor, getStateColor } from './layouts/shared.ts';
