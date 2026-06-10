import { AgentStatus, compareStatus, windowLabel, type AgentState } from '../state/types.ts';

// A rendered dashboard line: sessions with 2+ agents get a header row followed
// by grouped (indented, window-named) agent rows; singletons render inline.
export type DashboardRow =
  | { kind: 'header'; session: string; count: number; aggregate: AgentStatus }
  | { kind: 'agent'; state: AgentState; grouped: boolean };

export const TuiMode = {
  DASHBOARD: 'DASHBOARD',
  PREVIEW: 'PREVIEW',
  SEND: 'SEND',
  HELP: 'HELP',
  PASSTHROUGH: 'PASSTHROUGH',
  CONFIRM_KILL: 'CONFIRM_KILL',
} as const;

export type TuiMode = (typeof TuiMode)[keyof typeof TuiMode];

export interface Summary {
  total: number;
  permit: number;
  question: number;
  done: number;
  busy: number;
}

const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
const DEFAULT_SPLIT = 0.45;

export class TuiApp {
  private states: AgentState[] = [];
  private filter: string = '';
  private filtering: boolean = false;
  selectedIndex: number = 0;
  mode: TuiMode = TuiMode.DASHBOARD;
  private modeBeforeSend: TuiMode = TuiMode.DASHBOARD;
  private modeBeforeKill: TuiMode = TuiMode.DASHBOARD;
  sendBuffer: string = '';
  shouldQuit: boolean = false;
  splitRatio: number = DEFAULT_SPLIT;
  dragging: boolean = false;

  updateStates(newStates: AgentState[]): void {
    const selectedPaneId = this.selectedState()?.paneId ?? null;
    this.states = newStates;

    if (selectedPaneId) {
      const visible = this.visibleStates();
      const newIdx = visible.findIndex((s) => s.paneId === selectedPaneId);
      if (newIdx >= 0) {
        this.selectedIndex = newIdx;
        return;
      }
    }
    this.clampSelection();
  }

  sortedStates(): AgentState[] {
    return [...this.states].sort((a, b) => {
      const cmp = compareStatus(a.status, b.status);
      if (cmp !== 0) return cmp;
      return a.session.localeCompare(b.session);
    });
  }

  // Flat agent list in rendered (grouped) order. Group order is each session's
  // first appearance in the urgency sort — i.e. its most urgent member's rank —
  // so an agent needing attention pulls its whole session to the top. Within a
  // group, rows sort by urgency then window name. dashboardRows() derives from
  // this, so selection indices stay valid against this list.
  visibleStates(): AgentState[] {
    const sorted = this.sortedStates();
    const noShell = sorted.filter((s) => s.status !== AgentStatus.SHELL && s.status !== AgentStatus.DOWN);
    const filtered = this.applyFilter(noShell);

    const groups = new Map<string, AgentState[]>();
    for (const s of filtered) {
      const members = groups.get(s.session);
      if (members) members.push(s);
      else groups.set(s.session, [s]);
    }

    const out: AgentState[] = [];
    for (const members of groups.values()) {
      members.sort((a, b) => {
        const cmp = compareStatus(a.status, b.status);
        if (cmp !== 0) return cmp;
        return windowLabel(a).localeCompare(windowLabel(b));
      });
      out.push(...members);
    }
    return out;
  }

  dashboardRows(): DashboardRow[] {
    const states = this.visibleStates();
    const rows: DashboardRow[] = [];
    let i = 0;
    while (i < states.length) {
      const session = states[i]!.session;
      let j = i;
      while (j < states.length && states[j]!.session === session) j++;
      const members = states.slice(i, j);
      if (members.length === 1) {
        rows.push({ kind: 'agent', state: members[0]!, grouped: false });
      } else {
        rows.push({ kind: 'header', session, count: members.length, aggregate: members[0]!.status });
        for (const member of members) rows.push({ kind: 'agent', state: member, grouped: true });
      }
      i = j;
    }
    return rows;
  }

  // Row index (header lines included) of the selected agent, for scroll math.
  selectedRowIndex(): number {
    const selected = this.selectedState();
    if (!selected) return 0;
    const idx = this.dashboardRows().findIndex((r) => r.kind === 'agent' && r.state.paneId === selected.paneId);
    return Math.max(0, idx);
  }

  shellCount(): number {
    return this.states.filter((s) => s.status === AgentStatus.SHELL || s.status === AgentStatus.DOWN).length;
  }

  private applyFilter(states: AgentState[]): AgentState[] {
    if (this.filter.length === 0) return states;
    const lower = this.filter.toLowerCase();
    return states.filter(
      (s) =>
        s.session.toLowerCase().includes(lower) ||
        s.window.toLowerCase().includes(lower) ||
        (s.claudeName?.toLowerCase().includes(lower) ?? false) ||
        (s.project?.toLowerCase().includes(lower) ?? false),
    );
  }

  selectedState(): AgentState | null {
    const visible = this.visibleStates();
    if (visible.length === 0) return null;
    const idx = Math.min(this.selectedIndex, visible.length - 1);
    return visible[idx] ?? null;
  }

  setFilter(text: string): void {
    this.filter = text;
    this.filtering = true;
    this.selectedIndex = 0;
  }

  getFilter(): string {
    return this.filter;
  }

  isFiltering(): boolean {
    return this.filtering;
  }

  clearFilter(): void {
    this.filter = '';
    this.filtering = false;
    this.selectedIndex = 0;
  }

  enterSend(): void {
    this.modeBeforeSend = this.mode;
    this.mode = TuiMode.SEND;
    this.sendBuffer = '';
  }

  exitSend(): void {
    this.mode = this.modeBeforeSend;
    this.sendBuffer = '';
  }

  enterKillConfirm(): void {
    this.modeBeforeKill = this.mode;
    this.mode = TuiMode.CONFIRM_KILL;
  }

  exitKillConfirm(): void {
    this.mode = this.modeBeforeKill;
  }

  enterPassthrough(): void {
    this.mode = TuiMode.PASSTHROUGH;
  }

  exitPassthrough(): void {
    this.mode = TuiMode.PREVIEW;
  }

  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  moveDown(): void {
    const max = this.visibleStates().length - 1;
    if (this.selectedIndex < max) this.selectedIndex++;
  }

  summary(): Summary {
    return {
      total: this.states.length,
      permit: this.states.filter((s) => s.status === AgentStatus.PERMIT).length,
      question: this.states.filter((s) => s.status === AgentStatus.QUESTION).length,
      done: this.states.filter((s) => s.status === AgentStatus.DONE).length,
      busy: this.states.filter((s) => s.status === AgentStatus.BUSY).length,
    };
  }

  listWidth(cols: number): number {
    return Math.floor(cols * this.splitRatio);
  }

  startDrag(): void {
    this.dragging = true;
  }

  updateDrag(x: number, cols: number): void {
    if (!this.dragging) return;
    this.splitRatio = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, x / cols));
  }

  endDrag(): void {
    this.dragging = false;
  }

  private clampSelection(): void {
    const max = Math.max(0, this.visibleStates().length - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
  }
}
