import { AgentStatus, compareStatus, type AgentState } from '../state/types.ts';
import { switchClient, displayMessage, currentPaneId } from '../tmux/sessions.ts';

export function runNext(states: AgentState[]): number {
  const currentPane = currentPaneId();
  const waiting = states
    .filter(
      (s) => s.status === AgentStatus.PERMIT || s.status === AgentStatus.QUESTION || s.status === AgentStatus.DONE,
    )
    .sort((a, b) => compareStatus(a.status, b.status));

  if (waiting.length === 0) {
    displayMessage('No waiting agents');
    return 0;
  }

  let target = waiting[0]!;
  if (currentPane) {
    const currentIdx = waiting.findIndex((s) => s.paneId === currentPane);
    if (currentIdx >= 0) {
      target = waiting[(currentIdx + 1) % waiting.length]!;
    }
  }

  try {
    switchClient(target.paneId);
    return 0;
  } catch {
    displayMessage(`Failed to switch to ${target.paneId}`);
    return 1;
  }
}
