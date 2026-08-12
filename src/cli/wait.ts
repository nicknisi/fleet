import { AgentStatus, type AgentState } from '../state/types.ts';
import { describeSelector, resolveSelector } from '../state/selector.ts';
import { EXIT } from './exit-codes.ts';

// Matches the app's FAST_REFRESH_MS (index.ts:40) — poll on the same cadence the
// TUI refreshes, so `wait` observes state transitions as promptly as the app does.
export const POLL_MS = 500;

export interface RunWaitOptions {
  selectors: string[]; // one or more positional selectors (pane/window/session/session:window)
  stateArgs: string[]; // one or more --state values (any of them satisfies)
  timeoutArg: string | undefined; // value after --timeout (seconds), if present
  any: boolean; // --any: succeed when ANY selector is satisfied (default: ALL)
  getStates: () => AgentState[]; // prod: () => fullRefreshStates(dirs)
  tmuxOk?: () => boolean; // false means presence is Unknown; keep waiting
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

export interface ParsedWaitArgs {
  selectors: string[];
  stateArgs: string[];
  timeoutArg: string | undefined;
  any: boolean;
}

// Split `wait`'s raw argv (everything after the `wait` verb) into positional
// selectors, repeated --state values, an optional --timeout, and the --any
// flag. Kept pure so the router stays a thin wire-up.
export function parseWaitArgs(args: string[]): ParsedWaitArgs {
  const selectors: string[] = [];
  const stateArgs: string[] = [];
  let timeoutArg: string | undefined;
  let any = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--state') {
      const v = args[i + 1];
      if (v !== undefined) stateArgs.push(v);
      i++;
    } else if (a === '--timeout') {
      timeoutArg = args[i + 1];
      i++;
    } else if (a === '--any') {
      any = true;
    } else if (!a.startsWith('--')) {
      selectors.push(a);
    }
  }

  return { selectors, stateArgs, timeoutArg, any };
}

const USAGE = 'Usage: fleet wait <selector...> --state <state> [--state <state>...] [--any] [--timeout <seconds>]\n';

export async function runWait(opts: RunWaitOptions): Promise<number> {
  const err =
    opts.stderr ??
    ((s: string) => {
      process.stderr.write(s);
    });

  if (opts.selectors.length === 0 || opts.stateArgs.length === 0) {
    err(USAGE);
    return EXIT.USAGE;
  }

  const targets = new Set<AgentStatus>();
  for (const raw of opts.stateArgs) {
    const parsed = parseWaitState(raw);
    if (parsed === null) {
      err(`Unknown state '${raw}'. Valid: ready|waiting|asking|working|idle\n`);
      return EXIT.USAGE;
    }
    targets.add(parsed);
  }

  let timeoutSecs: number | null = null;
  if (opts.timeoutArg !== undefined) {
    const n = Number(opts.timeoutArg);
    if (!Number.isFinite(n) || n < 0) {
      err(`Invalid --timeout '${opts.timeoutArg}': expected a non-negative number of seconds\n`);
      return EXIT.USAGE;
    }
    timeoutSecs = n;
  }

  const startMs = opts.now();
  const deadlineMs = timeoutSecs === null ? null : startMs + timeoutSecs * 1000;
  let firstPoll = true;
  const seen = new Set<string>(); // selectors that have matched at least once

  for (;;) {
    const states = opts.getStates();

    // A failed tmux query makes every pane Unknown, not Absent. Do not turn a
    // transient server hiccup into "disappeared"; keep waiting until recovery
    // or the caller's timeout.
    if (opts.tmuxOk && !opts.tmuxOk()) {
      if (deadlineMs !== null && opts.now() >= deadlineMs) return EXIT.TIMEOUT;
      firstPoll = false;
      await opts.sleep(POLL_MS);
      continue;
    }

    // Resolve every selector this poll: its current matches and whether any of
    // those matches is at a target state.
    const resolved = opts.selectors.map((sel) => {
      const r = resolveSelector(sel, states);
      const satisfied = r.matches.length > 0 && r.matches.some((s) => targets.has(s.status));
      if (r.matches.length > 0) seen.add(sel);
      return { sel, r, present: r.matches.length > 0, satisfied };
    });

    // Success is checked before any miss/timeout: --any needs just one selector
    // satisfied, the default needs them all.
    const reached = opts.any ? resolved.some((x) => x.satisfied) : resolved.every((x) => x.satisfied);
    if (reached) return EXIT.OK;

    // Missing before expired. In ALL mode every selector must exist, so any
    // miss is terminal. In ANY mode a missing selector is irrelevant while at
    // least one other selector still exists and may satisfy the target.
    const missing = resolved.find((x) => !x.present);
    const allMissing = resolved.every((x) => !x.present);
    if (missing && (!opts.any || allMissing)) {
      if (firstPoll || !seen.has(missing.sel)) {
        err(`No agents found matching ${describeSelector(missing.r)}\n`);
      } else {
        err(`${describeSelector(missing.r)} disappeared while waiting\n`);
      }
      return EXIT.NO_MATCH;
    }

    if (deadlineMs !== null && opts.now() >= deadlineMs) return EXIT.TIMEOUT;

    firstPoll = false;
    await opts.sleep(POLL_MS);
  }
}
