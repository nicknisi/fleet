// Acknowledgement marks a finished agent as seen. The hook status file is the
// only signal that always exists for a tracked pane (the event log may not), so
// acknowledgement is anchored there: flip a ready hook state to idle.

const READY_HOOK_STATES = new Set(['done', 'completed']);

// Given the current parsed status-file object, return the updated object that
// marks the agent acknowledged (idle), or null if it isn't in a ready state —
// we only clear finished turns, never a working/waiting/asking agent.
export function acknowledgedStatus(current: Record<string, unknown>, now: number): Record<string, unknown> | null {
  if (!READY_HOOK_STATES.has(String(current.state))) return null;
  return { ...current, state: 'idle', ts: now };
}
