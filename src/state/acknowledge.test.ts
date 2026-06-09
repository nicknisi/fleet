import { describe, expect, test } from 'bun:test';
import { acknowledgedStatus, acknowledgePlan } from './acknowledge.ts';
import type { EventEntry } from './types.ts';

describe('acknowledgedStatus', () => {
  const base = { pane: '%30', session: 'authkit', tool: '', tmux_pid: 91985 };

  test('flips a done state to idle with a fresh timestamp', () => {
    const result = acknowledgedStatus({ ...base, state: 'done', ts: 100 }, 500);
    expect(result).not.toBeNull();
    expect(result!.state).toBe('idle');
    expect(result!.ts).toBe(500);
    expect(result!.pane).toBe('%30');
    expect(result!.session).toBe('authkit');
  });

  test('flips a completed state to idle (status files use both spellings)', () => {
    const result = acknowledgedStatus({ ...base, state: 'completed', ts: 100 }, 500);
    expect(result!.state).toBe('idle');
  });

  test('refuses to acknowledge a working agent', () => {
    expect(acknowledgedStatus({ ...base, state: 'working', ts: 100 }, 500)).toBeNull();
  });

  test('refuses to acknowledge a waiting/asking agent', () => {
    expect(acknowledgedStatus({ ...base, state: 'permit', ts: 100 }, 500)).toBeNull();
    expect(acknowledgedStatus({ ...base, state: 'question', ts: 100 }, 500)).toBeNull();
  });

  test('leaves an already-idle agent alone', () => {
    expect(acknowledgedStatus({ ...base, state: 'idle', ts: 100 }, 500)).toBeNull();
  });
});

describe('acknowledgePlan', () => {
  const base = { pane: '%30', session: 'authkit', tool: '', tmux_pid: 91985 };
  const stop: EventEntry = { event: 'Stop', ts: 100 };
  const busy: EventEntry = { event: 'PreToolUse', ts: 100, tool: 'Bash' };
  const asking: EventEntry = { event: 'PreToolUse', ts: 100, tool: 'AskUserQuestion' };

  test('retires an event-derived DONE even when the status file is idle', () => {
    // The bar's DONE comes from a Stop event; the hook status file lags at idle.
    const plan = acknowledgePlan({ ...base, state: 'idle', ts: 100 }, [stop], 500);
    expect(plan.status).toBeNull(); // nothing to flip in the status file
    expect(plan.appendAck).toBe(true); // but the event-derived DONE must be cleared
  });

  test('both flips the status file and appends ack when the file says done', () => {
    const plan = acknowledgePlan({ ...base, state: 'done', ts: 100 }, [stop], 500);
    expect(plan.status!.state).toBe('idle');
    expect(plan.appendAck).toBe(true);
  });

  test('flips a done status file even when there are no events', () => {
    const plan = acknowledgePlan({ ...base, state: 'done', ts: 100 }, [], 500);
    expect(plan.status!.state).toBe('idle');
    expect(plan.appendAck).toBe(false);
  });

  test('no-op for an idle agent with no ready signal', () => {
    const plan = acknowledgePlan({ ...base, state: 'idle', ts: 100 }, [busy], 500);
    expect(plan.status).toBeNull();
    expect(plan.appendAck).toBe(false);
  });

  test('never acknowledges an asking agent (event-derived QUESTION)', () => {
    const plan = acknowledgePlan({ ...base, state: 'idle', ts: 100 }, [asking], 500);
    expect(plan.status).toBeNull();
    expect(plan.appendAck).toBe(false);
  });
});
