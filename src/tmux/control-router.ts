// Pure decision logic for the TUI's optional control-mode fast path. The
// TUI owns the latch (a ControlLatch object) and the live TmuxControlClient;
// this module only answers "should this tick read via control or fork?" and
// "an error happened — flip the latch?". No I/O, no imports of the client —
// fully unit-testable.
//
// Semantics (see the integration sketch at the bottom of control.ts):
//   - Opt-in: enabled only when $TMUX is set and FLEET_CONTROL_MODE !== '0'.
//     TUI-only is structural — launchTui is the sole caller.
//   - Permanent fallback: the moment a control read throws, the latch flips
//     to dead for the rest of the session. selectReadPath() then returns
//     'fork' forever; the caller close()s the client and never retries.

export interface ControlLatch {
  dead: boolean;
}

export interface ControlModeState {
  /** $TMUX set and FLEET_CONTROL_MODE !== '0' (computed once at startup). */
  enabled: boolean;
  /** A control client connected successfully and is still referenced. */
  connected: boolean;
  /** The latch has been flipped by a prior error — never retries. */
  dead: boolean;
}

export type ReadPath = 'control' | 'fork';

/** control iff enabled + connected + not dead; otherwise fork. */
export function selectReadPath(s: ControlModeState): ReadPath {
  return s.enabled && s.connected && !s.dead ? 'control' : 'fork';
}

/** True when the TUI should attempt a control-mode connection. */
export function shouldAttemptControl(env: Record<string, string | undefined>): boolean {
  if (env.FLEET_CONTROL_MODE === '0') return false;
  const tmux = env.TMUX;
  return tmux !== undefined && tmux.length > 0;
}

/** Flip the latch to dead (permanent for the session). Idempotent. */
export function flipControlDead(latch: ControlLatch): void {
  latch.dead = true;
}
