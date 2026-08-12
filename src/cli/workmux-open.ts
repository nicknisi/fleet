// `fleet workmux-open <selector>`: resolve a selector to an already-enriched
// agent and hand its workmux handle to `workmux open`. Read-only routing — it
// never mutates git or worktree state, only asks workmux to focus an existing
// entry. When workmux isn't installed (or the pane isn't workmux-managed) it
// returns a clear, nonzero diagnostic instead of guessing.

import { EXIT, type ExitCode } from './exit-codes.ts';
import { resolveSelector, describeSelector, type Selectable } from '../state/selector.ts';
import type { AgentState } from '../state/types.ts';
import { isWorkmuxAvailable, workmuxOpen } from '../adapters/workmux.ts';

export interface WorkmuxOpenDeps {
  states: AgentState[];
  available: () => boolean;
  open: (handle: string) => { code: number; stderr: string };
  err: (s: string) => void;
}

// Pure-ish core: takes the enriched states + injectable workmux hooks so tests
// can drive every branch without a real workmux. Returns a process exit code.
export function runWorkmuxOpen(args: string[], deps: WorkmuxOpenDeps): ExitCode {
  const selector = args.find((a) => !a.startsWith('--'));
  if (!selector) {
    deps.err('Usage: fleet workmux-open <selector>\n');
    return EXIT.USAGE;
  }

  if (!deps.available()) {
    deps.err('workmux is not installed \u2014 install workmux to use `fleet workmux-open`.\n');
    return EXIT.USAGE;
  }

  const selectable: Selectable[] = deps.states.map((s) => ({
    paneId: s.paneId,
    windowId: s.windowId,
    session: s.session,
    window: s.window,
  }));
  const match = resolveSelector(selector, selectable);

  if (match.matches.length === 0) {
    deps.err(`No agent matched ${describeSelector(match)}.\n`);
    return EXIT.NO_MATCH;
  }
  if (match.matches.length > 1) {
    deps.err(`${describeSelector(match)} matched ${match.matches.length} agents \u2014 narrow the selector.\n`);
    return EXIT.AMBIGUOUS;
  }

  const pane = match.matches[0]!.paneId;
  const state = deps.states.find((s) => s.paneId === pane)!;
  const workmux = state.workmux;
  if (!workmux) {
    deps.err(`Agent ${describeSelector(match)} is not managed by workmux.\n`);
    return EXIT.NO_MATCH;
  }

  const result = deps.open(workmux.handle);
  if (result.code !== 0) {
    deps.err(`workmux open failed: ${result.stderr.trim() || `exit ${result.code}`}\n`);
    return EXIT.USAGE;
  }
  return EXIT.OK;
}

// Thin wrapper binding the real workmux adapter for the router.
export function workmuxOpenCli(args: string[], states: AgentState[]): ExitCode {
  return runWorkmuxOpen(args, {
    states,
    available: isWorkmuxAvailable,
    open: workmuxOpen,
    err: (s) => process.stderr.write(s),
  });
}
