// Stable, documented process exit codes for the observability CLI surface.
// Scripts pipe on these, so their numeric values are part of the contract and
// must not shift. Human display commands (the TUI, `fleet status <session>`)
// keep their historical 0/1 behavior; these codes govern the machine-readable
// verbs (list/status --json, watch, wait, capture).
//
//   0   OK                 success / at least one match
//   1   USAGE              bad or missing arguments
//   2   NO_MATCH           a selector matched no agent
//   3   AMBIGUOUS          a selector matched multiple where exactly one was required
//   4   TMUX_UNAVAILABLE   tmux could not be queried (server down / not in tmux)
//   124 TIMEOUT            a bounded wait crossed its deadline (timeout(1) convention)
export const EXIT = {
  OK: 0,
  USAGE: 1,
  NO_MATCH: 2,
  AMBIGUOUS: 3,
  TMUX_UNAVAILABLE: 4,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
