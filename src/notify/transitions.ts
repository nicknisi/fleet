import { AgentStatus, type AgentState, sessionLabel } from '../state/types.ts';

// Stopped states that warrant attention. IDLE is included so hook-less discovered
// agents (Phase 3: BUSY-glyph -> IDLE-no-glyph) notify; hooked agents normally land
// on DONE/PERMIT/QUESTION. NB: relies on states being debounced upstream — Phase 3
// must not flip discovered agents BUSY<->IDLE on single-frame flicker.
const STOP_STATES: ReadonlySet<AgentStatus> = new Set([
  AgentStatus.DONE,
  AgentStatus.PERMIT,
  AgentStatus.QUESTION,
  AgentStatus.IDLE,
]);

export interface Notification {
  paneId: string;
  agentType: string;
  label: string;
  status: AgentStatus;
}

// Detection: pure work->stop transitions this tick, no suppression applied. The
// returned `previous` is rebuilt from the current states, so a pane that vanished
// drops out naturally (no stale entries, no unbounded growth). A transition only
// fires when the pane's prior status was BUSY — a pane first observed already
// stopped has no BUSY predecessor and never false-fires (the arming condition).
export function decideNotifications(
  states: AgentState[],
  previous: Map<string, AgentStatus>,
): { candidates: Notification[]; previous: Map<string, AgentStatus> } {
  const next = new Map<string, AgentStatus>();
  const candidates: Notification[] = [];
  for (const s of states) {
    next.set(s.paneId, s.status);
    if (previous.get(s.paneId) === AgentStatus.BUSY && STOP_STATES.has(s.status)) {
      candidates.push({ paneId: s.paneId, agentType: s.agentType, label: sessionLabel(s), status: s.status });
    }
  }
  return { candidates, previous: next };
}

// Suppression: silent entirely while you're viewing fleet's own pane (you can see
// the change on the dashboard); otherwise drop the one pane you're viewing.
// activePaneId === null disables suppression (used when the active pane can't be
// resolved — better a redundant toast than a missed one).
export function applySuppression(
  candidates: Notification[],
  activePaneId: string | null,
  fleetPaneId: string | null,
): Notification[] {
  if (activePaneId != null && activePaneId === fleetPaneId) return []; // watching the dashboard
  return candidates.filter((c) => c.paneId !== activePaneId);
}
