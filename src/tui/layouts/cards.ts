import { C } from '../../terminal/colors.ts';
import { truncateAnsi, truncateWidth, visibleLength } from '../../terminal/ansi.ts';
import { STATUS_DISPLAY, windowLabel, type AgentState } from '../../state/types.ts';
import type { TuiApp } from '../app.ts';
import { formatAge, getAgeColor, getStateColor, type LayoutLines } from './shared.ts';

// Sidebar cards: every agent is a fixed 4-line block —
//   ▌⚠ name            4s
//   ▌  branch · agent
//   ▌  tool / state label
//   (blank)
// Uniform height keeps scroll math identical to the table's line windowing.
export function buildCardLines(app: TuiApp, cols: number): LayoutLines {
  const rows = app.dashboardRows();
  const selectedPane = app.selectedState()?.paneId ?? null;
  const lines: string[] = [];
  const states: (AgentState | null)[] = [];

  for (const row of rows) {
    if (row.kind === 'header') {
      const label = ` ${row.session} · ${row.count} `;
      const fill = Math.max(0, cols - visibleLength(label) - 4);
      lines.push(truncateAnsi(`${C.gray}──${C.bold}${label}${C.reset}${C.gray}${'─'.repeat(fill)}${C.reset}`, cols));
      states.push(null);
      continue;
    }
    const st = row.state;
    const selected = st.paneId === selectedPane;
    const color = getStateColor(st.status);
    const display = STATUS_DISPLAY[st.status];
    const bar = selected ? `${color}▌${C.reset}` : ' ';

    const age = formatAge(st.ts);
    // line 1 visible budget: bar(1) sp(1) icon(1) sp(1) name … sp(1) age
    const nameW = Math.max(1, cols - 5 - age.length);
    const name = truncateWidth(
      windowLabel(st) === st.session ? st.session : `${st.session} · ${windowLabel(st)}`,
      nameW,
    );
    const gap = ' '.repeat(Math.max(1, nameW - visibleLength(name) + 1));
    lines.push(
      truncateAnsi(
        `${bar} ${color}${display.icon}${C.reset} ${selected ? C.bold : ''}${name}${C.reset}${gap}${getAgeColor(st.ts)}${age}${C.reset}`,
        cols,
      ),
    );
    states.push(st);

    const meta = [st.branch, st.agentType].filter(Boolean).join(' · ');
    lines.push(truncateAnsi(`${bar}   ${C.gray}${truncateWidth(meta, Math.max(1, cols - 4))}${C.reset}`, cols));
    states.push(st);

    const detail = st.tool ?? st.claudeName ?? display.label;
    lines.push(truncateAnsi(`${bar}   ${C.dim}${truncateWidth(detail, Math.max(1, cols - 4))}${C.reset}`, cols));
    states.push(st);

    lines.push('');
    states.push(null);
  }

  // Drop the trailing blank so the last card doesn't waste a row.
  if (lines[lines.length - 1] === '') {
    lines.pop();
    states.pop();
  }
  return { lines, states };
}
