import { C } from '../../terminal/colors.ts';
import { padAnsi, truncateAnsi, truncateWidth, visibleLength } from '../../terminal/ansi.ts';
import { STATUS_DISPLAY, windowLabel, type AgentState } from '../../state/types.ts';
import type { DashboardRow, TuiApp } from '../app.ts';
import { formatAge, getAgeColor, getStateColor, stateIcon, type LayoutLines } from './shared.ts';

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
  hovered: boolean,
  pulse: boolean,
): string {
  const state = row.state;
  const stColor = getStateColor(state.status);

  const sel = selected ? `${stColor}▌${C.reset}` : ' ';

  const nameColor = selected ? C.bold : hovered ? C.underline : '';
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
  const line = `${sel} ${stateIcon(state.status, pulse)} ${nameColor}${name}${C.reset}${detailColor}${padAnsi(truncateWidth(detail, widths.detail), widths.detail)}${C.reset}${branchPart} ${ageColor}${age.padEnd(4)}${C.reset}${portStr}`;

  return truncateAnsi(line, cols);
}

export function buildTableLines(app: TuiApp, cols: number): LayoutLines {
  const rows = app.dashboardRows();
  const widths = computeColumnWidths(rows, cols);
  const selectedPane = app.selectedState()?.paneId ?? null;
  const lines: string[] = [];
  const states: (AgentState | null)[] = [];
  for (const row of rows) {
    if (row.kind === 'header') {
      lines.push(formatHeaderRow(row, cols));
      states.push(null);
    } else {
      lines.push(
        formatAgentRow(
          row,
          widths,
          cols,
          row.state.paneId === selectedPane,
          row.state.paneId === app.hoverPaneId,
          app.pulsePhase,
        ),
      );
      states.push(row.state);
    }
  }
  return { lines, states };
}
