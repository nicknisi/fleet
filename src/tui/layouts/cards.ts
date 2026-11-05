import { C } from '../../terminal/colors.ts';
import { padAnsi, truncateAnsi, truncateWidth, visibleLength } from '../../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, agentSessionName, windowLabel, type AgentState } from '../../state/types.ts';
import type { TuiApp } from '../app.ts';
import { formatAge, getStateColor, WORKING_FRAMES, type LayoutLines } from './shared.ts';

// Agent-type glyphs. Unknown types fall back to the status icon.
const AGENT_GLYPHS = new Map([
  ['claude', '✳'],
  ['pi', 'π'],
  ['codex', '◆'],
]);

// Sidebar list (Rex-style): every agent sits under a plain group header, one
// line per agent; the selected agent gets a background highlight and one
// detail line. Groups are separated by a blank line.
//
//   riker
//    ✳ Fix screenshot text real… ⚠ 2m
//    π Riker WIF integration te… ⠋
//
//   authkit
//    ◧ ✳ AuthKit session issue  ● 4s   ← selected (background)
//        main · claude · Read
//
// The column before the agent glyph shows where the pane sits when another
// agent shares its tmux window (◧ ◨ ⬒ ⬓, ⊞ for 3+); blank when it has the window
// to itself (non-agent panes like editors and shells don't count).
export function buildCardLines(app: TuiApp, cols: number): LayoutLines {
  const rows = app.dashboardRows();
  const selectedPane = app.selectedState()?.paneId ?? null;
  const windowAgents = agentsByWindow(app.sortedStates());
  const lines: string[] = [];
  const states: (AgentState | null)[] = [];

  const header = (label: string): void => {
    if (lines.length > 0) {
      lines.push('');
      states.push(null);
    }
    lines.push(truncateAnsi(` ${C.gray}${truncateWidth(label, cols - 1)}${C.reset}`, cols));
    states.push(null);
  };

  for (const row of rows) {
    if (row.kind === 'header') {
      header(row.label);
      continue;
    }
    const st = row.state;
    // Singleton sessions have no header row in dashboardRows; give them one here.
    if (!row.grouped) header(app.groupLabel(st).label);

    const selected = st.paneId === selectedPane;
    const hovered = st.paneId === app.hoverPaneId;
    const color = getStateColor(st.status);
    const glyph = AGENT_GLYPHS.get(st.agentType) ?? STATUS_DISPLAY[st.status].icon;

    const right = rightMarker(st, app.spinnerFrame);
    const rightW = visibleLength(right);
    // The marker sits flush right (like the old age column); markerless rows keep a 1-cell margin.
    const titleW = Math.max(1, cols - 5 - (rightW > 0 ? rightW + 1 : 1));
    const title = padAnsi(truncateWidth(agentSessionName(st) ?? windowLabel(st), titleW), titleW);
    const titleStyle =
      st.status === AgentStatus.PERMIT || st.status === AgentStatus.QUESTION
        ? C.bold
        : st.status === AgentStatus.IDLE
          ? C.idle
          : '';
    const tail = rightW > 0 ? ` ${color}${right}${C.reset}` : ' ';
    const mark = selected && !C.selBg ? '›' : ' ';
    const split = splitGlyph(st, windowAgents.get(st.windowId) ?? []);
    lines.push(
      highlight(
        `${mark}${C.gray}${split}${C.reset} ${color}${glyph}${C.reset} ${titleStyle}${hovered ? C.underline : ''}${title}${C.reset}${tail}`,
        cols,
        selected,
      ),
    );
    states.push(st);

    if (selected) {
      const detail = [st.branch, st.agentType, st.tool ?? STATUS_DISPLAY[st.status].label].filter(Boolean).join(' · ');
      lines.push(highlight(`     ${C.gray}${truncateWidth(detail, Math.max(1, cols - 6))}${C.reset}`, cols, true));
      states.push(st);
    }
  }
  return { lines, states };
}

// Live agents (not shells or dead panes) keyed by tmux window.
function agentsByWindow(states: readonly AgentState[]): Map<string, AgentState[]> {
  const byWindow = new Map<string, AgentState[]>();
  for (const s of states) {
    if (s.status === AgentStatus.SHELL || s.status === AgentStatus.DOWN) continue;
    byWindow.set(s.windowId, [...(byWindow.get(s.windowId) ?? []), s]);
  }
  return byWindow;
}

// Which side of the split this agent is on, relative to its one window-mate.
export function splitGlyph(st: AgentState, windowAgents: readonly AgentState[]): string {
  if (windowAgents.length < 2) return ' ';
  const mate = windowAgents.length === 2 ? windowAgents.find((s) => s.paneId !== st.paneId) : undefined;
  const [l, t, ml, mt] = [st.paneLeft, st.paneTop, mate?.paneLeft, mate?.paneTop];
  if (l === undefined || t === undefined || ml === undefined || mt === undefined) return '⊞';
  if (l !== ml) return l < ml ? '◧' : '◨';
  return t < mt ? '⬒' : '⬓';
}

// State + age for rows that want attention, a spinner while working, nothing
// when idle. Glyphs differ per state, so this still reads without color.
function rightMarker(st: AgentState, frame: number): string {
  switch (st.status) {
    case AgentStatus.IDLE:
    case AgentStatus.SHELL:
    case AgentStatus.DOWN:
      return '';
    case AgentStatus.BUSY:
      return WORKING_FRAMES[frame % WORKING_FRAMES.length] ?? WORKING_FRAMES[0];
    default:
      return `${STATUS_DISPLAY[st.status].icon} ${formatAge(st.ts)}`;
  }
}

// Fill the row with the selection background. Resets (and colors like gray
// that start with `0;`) drop the background, so re-apply it after every SGR.
function highlight(line: string, cols: number, selected: boolean): string {
  const fitted = padAnsi(truncateAnsi(line, cols), cols);
  if (!selected || !C.selBg) return fitted;
  // oxlint-disable-next-line no-control-regex
  return `${C.selBg}${fitted.replace(/\x1b\[[0-9;]*m/g, (sgr) => sgr + C.selBg)}${C.reset}`;
}
