// Tri-state pane reconciliation. A tracked pane (one with a .status file) is
// either Present (live in tmux), Absent (tmux answered and the pane is gone),
// or Unknown (the list-panes query itself failed, so we cannot tell). Only an
// Absent pane is safe to delete; Unknown must NEVER delete, so a transient tmux
// hiccup — the whole server momentarily unreachable — can't wipe live state.
//
// This is the minimum seam the reconcile sweep and the E2E harness share: one
// list-panes result classifies every tracked pane, instead of a per-pane query
// that conflates "this pane is dead" with "tmux is down".

import type { ListPanesResult } from '../tmux/sessions.ts';

export type Presence = 'present' | 'absent' | 'unknown';

export interface LivePaneSet {
  ok: boolean; // did the list-panes query succeed?
  paneIds: ReadonlySet<string>; // live pane ids when ok; empty + ok=false on failure
}

// Fold a list-panes result into the presence lookup. A failed query (ok=false)
// carries no pane ids, so every classifyPane against it returns 'unknown'.
export function livePaneSet(result: ListPanesResult): LivePaneSet {
  return { ok: result.ok, paneIds: new Set(result.panes.map((p) => p.paneId)) };
}

export function classifyPane(paneId: string, live: LivePaneSet): Presence {
  if (!live.ok) return 'unknown'; // couldn't reach tmux — indeterminate, never delete
  return live.paneIds.has(paneId) ? 'present' : 'absent';
}

// Reconciliation deletes only Absent panes (tmux confirmed the pane is gone).
// Present is live; Unknown is a transient failure. Fail closed on deletion:
// anything but a definitive Absent is retained.
export function isDeletable(presence: Presence): boolean {
  return presence === 'absent';
}
