import { describe, expect, test } from 'bun:test';
import { flipControlDead, selectReadPath, shouldAttemptControl, type ControlLatch } from './control-router.ts';

describe('selectReadPath', () => {
  test('control only when enabled + connected + not dead', () => {
    expect(selectReadPath({ enabled: true, connected: true, dead: false })).toBe('control');
  });

  test('fork when disabled', () => {
    expect(selectReadPath({ enabled: false, connected: true, dead: false })).toBe('fork');
  });

  test('fork when not connected', () => {
    expect(selectReadPath({ enabled: true, connected: false, dead: false })).toBe('fork');
  });

  test('fork when dead (permanent fallback — never retries)', () => {
    expect(selectReadPath({ enabled: true, connected: true, dead: true })).toBe('fork');
  });

  test('dead wins over connected (latch is sticky)', () => {
    expect(selectReadPath({ enabled: false, connected: true, dead: true })).toBe('fork');
  });
});

describe('shouldAttemptControl', () => {
  test('true when $TMUX set and FLEET_CONTROL_MODE is not "0"', () => {
    expect(shouldAttemptControl({ TMUX: '/tmp/x,1,2' })).toBe(true);
    expect(shouldAttemptControl({ TMUX: '/tmp/x,1,2', FLEET_CONTROL_MODE: '1' })).toBe(true);
  });

  test('false when FLEET_CONTROL_MODE === "0" (explicit opt-out)', () => {
    expect(shouldAttemptControl({ TMUX: '/tmp/x,1,2', FLEET_CONTROL_MODE: '0' })).toBe(false);
  });

  test('false outside tmux (no $TMUX)', () => {
    expect(shouldAttemptControl({})).toBe(false);
  });

  test('false when $TMUX is empty', () => {
    expect(shouldAttemptControl({ TMUX: '' })).toBe(false);
  });

  test('false when $TMUX is undefined', () => {
    expect(shouldAttemptControl({ TMUX: undefined })).toBe(false);
  });
});

describe('flipControlDead', () => {
  test('flips a live latch to dead', () => {
    const latch: ControlLatch = { dead: false };
    flipControlDead(latch);
    expect(latch.dead).toBe(true);
  });

  test('idempotent — flipping a dead latch stays dead', () => {
    const latch: ControlLatch = { dead: true };
    flipControlDead(latch);
    expect(latch.dead).toBe(true);
  });

  test('mutates the same object (no replacement)', () => {
    const latch: ControlLatch = { dead: false };
    flipControlDead(latch);
    // The caller keeps the reference; the latch is not swapped out from under it.
    expect(latch).toEqual({ dead: true });
  });
});
