// Async adapters that route the TUI's list-panes + per-pane capture reads
// through a long-lived TmuxControlClient instead of one fork per command.
// They reuse sessions.ts's format string, row parser, and capture output
// post-processing so pane data shapes are byte-identical to the fork path —
// the only difference is the transport. Errors propagate (the TUI's tick
// wrapper catches them and flips the control latch).

import type { TmuxControlClient } from './control.ts';
import {
  listPanesCommand,
  parsePanesOutput,
  processCaptureOutput,
  type ListPanesResult,
} from './sessions.ts';

/** The subset of TmuxControlClient the adapters need — also a stub seam. */
export interface ControlReadClient {
  run(cmd: string): Promise<string>;
  capturePane(paneId: string): Promise<string>;
}

/**
 * list-panes via control mode. Runs the SAME format string sessions.ts uses
 * (listPanesCommand) and parses with parsePanesOutput, so PaneInfo shapes are
 * identical to the fork path. Throws on %error / exit / death — the caller
 * flips the control latch and falls back to the fork path for the batch.
 */
export async function listPanesResultVia(client: ControlReadClient): Promise<ListPanesResult> {
  const stdout = await client.run(listPanesCommand());
  return { ok: true, panes: parsePanesOutput(stdout) };
}

/**
 * capture-pane via control mode (the buffer + save-buffer dance in
 * TmuxControlClient.capturePane), then the same line post-processing the fork
 * path applies, so the scraper sees an identical line array.
 */
export async function capturePaneVia(
  client: ControlReadClient,
  paneId: string,
  maxLines: number,
): Promise<string[]> {
  const output = await client.capturePane(paneId);
  return processCaptureOutput(output, maxLines);
}

// Exported so callers can pass a typed null without importing the class.
export type { TmuxControlClient };
