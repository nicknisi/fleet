import { AgentStatus, compareStatus, type AgentState } from '../state/types.ts';

export const TuiMode = {
  DASHBOARD: 'DASHBOARD',
  PREVIEW: 'PREVIEW',
  SEND: 'SEND',
  HELP: 'HELP',
  PASSTHROUGH: 'PASSTHROUGH',
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

  visibleStates(): AgentState[] {
    const sorted = this.sortedStates();
    const noShell = sorted.filter((s) => s.status !== AgentStatus.SHELL && s.status !== AgentStatus.DOWN);
    return this.applyFilter(noShell);
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
