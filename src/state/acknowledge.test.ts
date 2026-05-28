import { describe, expect, test } from 'bun:test';
import { acknowledgedStatus } from './acknowledge.ts';

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
