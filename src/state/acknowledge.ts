// Acknowledgement marks a finished agent as seen. A ready agent's DONE has two
// independent sources, and acknowledgement must retire both:
//   1. The hook status file says 'done'/'completed' — flip it to idle.
//   2. The event stream derives DONE (a Stop/SubagentStop turn-end) — the bar
//      shows DONE even when the status file lags at idle, so append an
//      Acknowledged event, which deriveStatusFromEvents maps back to idle.
// Anchoring on the status file alone silently no-ops the (common) event-derived
// case, leaving the agent stuck on the bar.

import { deriveStatusFromEvents } from './events.ts';
import { AgentStatus, type EventEntry } from './types.ts';

const READY_HOOK_STATES = new Set(['done', 'completed']);

// Given the current parsed status-file object, return the updated object that
// marks the agent acknowledged (idle), or null if it isn't in a ready state —
// we only clear finished turns, never a working/waiting/asking agent.
export function acknowledgedStatus(
  current: Record<string, unknown>,
  now: number,
): Record<string, unknown> | null {
  if (!READY_HOOK_STATES.has(String(current.state))) return null;
  return { ...current, state: 'idle', ts: now };
}

export interface AckPlan {
  // Rewritten status-file object, or null when the file isn't in a ready state.
  status: Record<string, unknown> | null;
  // Whether to append an Acknowledged event to retire an event-derived DONE.
  appendAck: boolean;
}

// Decide both acknowledgement actions for a pane from its current status-file
// object and recent events. Either signal being ready is enough to clear it; a
// non-DONE event stream (working/waiting/asking) leaves appendAck false, so
// PERMIT/QUESTION agents are never dismissed.
export function acknowledgePlan(
  current: Record<string, unknown>,
  recentEvents: EventEntry[],
  now: number,
): AckPlan {
  return {
    status: acknowledgedStatus(current, now),
    appendAck: deriveStatusFromEvents(recentEvents) === AgentStatus.DONE,
  };
}
