import { AgentStatus, type AgentState } from '../state/types.ts';

// Matches the app's FAST_REFRESH_MS (index.ts:40) — poll on the same cadence the
// TUI refreshes, so `wait` observes state transitions as promptly as the app does.
export const POLL_MS = 500;

export interface RunWaitOptions {
  session: string | undefined; // args[1]
  stateArg: string | undefined; // value after --state
  timeoutArg: string | undefined; // value after --timeout (seconds), if present
  getStates: () => AgentState[]; // prod: () => fullRefreshStates(statusDirs)
  sleep: (ms: number) => Promise<void>; // prod: (ms) => new Promise((r) => setTimeout(r, ms))
  now: () => number; // prod: () => Date.now()  (epoch ms)
  stderr?: (s: string) => void; // prod: (s) => { process.stderr.write(s); }
}

// Accepted --state values → AgentStatus, keyed by lowercased input. Both the
// display labels (STATUS_DISPLAY, types.ts) and the raw enum names are accepted.
// There is no READY enum — 'ready' is DONE's display label. SHELL/DOWN are
// intentionally omitted: they are not meaningful orchestration targets.
const WAIT_STATES: Record<string, AgentStatus> = {
  // display labels (STATUS_DISPLAY)
  ready: AgentStatus.DONE, // NOTE: 'ready' is DONE's label; there is no READY enum
  waiting: AgentStatus.PERMIT,
  asking: AgentStatus.QUESTION,
  working: AgentStatus.BUSY,
  idle: AgentStatus.IDLE,
  // raw enum names (idle/IDLE coincide once lowercased)
  done: AgentStatus.DONE,
  permit: AgentStatus.PERMIT,
  question: AgentStatus.QUESTION,
  busy: AgentStatus.BUSY,
};

export function parseWaitState(input: string): AgentStatus | null {
  return WAIT_STATES[input.trim().toLowerCase()] ?? null;
}

const USAGE = 'Usage: fleet wait <session> --state <state> [--timeout <seconds>]\n';

export async function runWait(opts: RunWaitOptions): Promise<number> {
  const err =
    opts.stderr ??
    ((s: string) => {
      process.stderr.write(s);
    });

  if (!opts.session) {
    err(USAGE);
    return 1;
  }
  if (!opts.stateArg) {
    err(USAGE);
    return 1;
  }

  const target = parseWaitState(opts.stateArg);
  if (target === null) {
    err(`Unknown state '${opts.stateArg}'. Valid: ready|waiting|asking|working|idle\n`);
    return 1;
  }

  let timeoutSecs: number | null = null;
  if (opts.timeoutArg !== undefined) {
    const n = Number(opts.timeoutArg);
    if (!Number.isFinite(n) || n < 0) {
      err(`Invalid --timeout '${opts.timeoutArg}': expected a non-negative number of seconds\n`);
      return 1;
    }
    timeoutSecs = n;
  }

  const startMs = opts.now();
  const deadlineMs = timeoutSecs === null ? null : startMs + timeoutSecs * 1000;
  let firstPoll = true;

  for (;;) {
    const inSession = opts.getStates().filter((s) => s.session === opts.session);

    // Missing before satisfied before expired: a first-poll miss is "not found",
    // a later miss means the session vanished mid-wait.
    if (inSession.length === 0) {
      err(
        firstPoll
          ? `No agents found in session '${opts.session}'\n`
          : `Session '${opts.session}' disappeared while waiting\n`,
      );
      return 1;
    }

    if (inSession.some((s) => s.status === target)) return 0; // reached → success

    if (deadlineMs !== null && opts.now() >= deadlineMs) return 124; // timeout(1) convention

    firstPoll = false;
    await opts.sleep(POLL_MS);
  }
}
