// `fleet capture --pane <selector> --lines <n> [--plain] [--json]` — a
// read-only window onto a pane's current buffer. It resolves the selector to
// exactly one pane (rejecting no-match and ambiguous-match), captures the
// bottom `n` lines WITHOUT escape sequences, and never writes anything back —
// no status files, no acknowledgements, no state mutation.
//
// Output is plain text by default (`--plain` is the explicit form of the
// default); `--json` additionally wraps the lines in the versioned envelope for
// a machine consumer.

import { type Selectable, resolveSelector, describeSelector } from '../state/selector.ts';
import { SCHEMA_VERSION, type Outcome } from './schema.ts';
import { EXIT } from './exit-codes.ts';

export const DEFAULT_CAPTURE_LINES = 50;

export interface CaptureArgs {
  paneSelector: string | null; // value after --pane
  lines: number | null; // value after --lines
  json: boolean; // --json present
  plain: boolean; // --plain present (default true anyway)
  linesRaw: string | null; // raw --lines token, for a precise error
}

// Parse capture's flags off the raw argv slice (everything after `capture`).
export function parseCaptureArgs(args: string[]): CaptureArgs {
  const paneIdx = args.indexOf('--pane');
  const linesIdx = args.indexOf('--lines');
  const linesRaw = linesIdx >= 0 ? (args[linesIdx + 1] ?? null) : null;
  return {
    paneSelector: paneIdx >= 0 ? (args[paneIdx + 1] ?? null) : null,
    lines: linesRaw !== null ? Number(linesRaw) : null,
    linesRaw,
    json: args.includes('--json'),
    plain: args.includes('--plain'),
  };
}

export interface RunCaptureDeps {
  panes: readonly Selectable[]; // live panes to resolve the selector against
  capture: (paneId: string, lines: number) => string[]; // read-only capture
  tmuxOk: boolean;
  now: number; // epoch ms
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = 'Usage: fleet capture --pane <id> [--lines <n>] [--plain] [--json]\n';

// Pure core so the resolve/reject logic is testable with injected panes and a
// fake capture function — no tmux required.
export function runCapture(args: CaptureArgs, deps: RunCaptureDeps): number {
  const fail = (outcome: Outcome, code: number, message: string): number => {
    if (args.json) {
      deps.out(
        JSON.stringify({
          schema: SCHEMA_VERSION,
          outcome,
          queriedAt: deps.now,
          selector: args.paneSelector,
          error: message.trim(),
        }) + '\n',
      );
    } else {
      deps.err(message);
    }
    return code;
  };

  if (!deps.tmuxOk) return fail('tmux_unavailable', EXIT.TMUX_UNAVAILABLE, 'tmux unavailable\n');
  if (args.paneSelector === null) return fail('unknown', EXIT.USAGE, USAGE);
  if (args.linesRaw !== null && (args.lines === null || !Number.isFinite(args.lines) || args.lines <= 0)) {
    return fail('unknown', EXIT.USAGE, `Invalid --lines '${args.linesRaw}': expected a positive number\n`);
  }
  const lines = args.lines ?? DEFAULT_CAPTURE_LINES;

  const resolved = resolveSelector(args.paneSelector, deps.panes);
  if (resolved.matches.length === 0) {
    return fail('no_match', EXIT.NO_MATCH, `No pane matched ${describeSelector(resolved)}\n`);
  }
  if (resolved.matches.length > 1) {
    const ids = resolved.matches.map((m) => m.paneId).join(', ');
    return fail(
      'ambiguous',
      EXIT.AMBIGUOUS,
      `Ambiguous ${describeSelector(resolved)} matched ${resolved.matches.length} panes: ${ids}\n`,
    );
  }

  const pane = resolved.matches[0]!;
  const captured = deps.capture(pane.paneId, lines);

  if (args.json) {
    deps.out(
      JSON.stringify({
        schema: SCHEMA_VERSION,
        outcome: 'ok',
        queriedAt: deps.now,
        selector: args.paneSelector,
        pane: pane.paneId,
        session: pane.session,
        lines: captured,
      }) + '\n',
    );
  } else {
    // Plain text is the default: the raw buffer, one line per line.
    deps.out(captured.join('\n') + (captured.length > 0 ? '\n' : ''));
  }
  return EXIT.OK;
}
