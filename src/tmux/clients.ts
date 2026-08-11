import { getTmuxOption, tmuxOrNull } from './ipc.ts';

// Multi-client focus model for notification suppression, ported from
// snirt/tmux-agents-mon's focus.rs. A pane counts as "focused" only when a
// real (non-control-mode) tmux client is viewing it AND, with focus-events on,
// that client carries the `focused` flag. With focus-events off we fall back to
// treating every real client's selected pane as focused (tmux can't tell us
// which client truly has keyboard focus).
//
// The popup-discount mechanism from the reference is intentionally NOT ported
// here; fleet has no popup today. If one is added, port `discount_client` so a
// popup owning one client's input doesn't suppress a second client viewing the
// same pane. (Future work.)

export interface ClientFocus {
  focusedPanes: Set<string>;
  activePaneId: string | null;
}

// Pure parser: turns the tab-separated `tmux list-clients -F` output into the
// focus set + highest-activity pane. Splitting into at most 6 fields keeps tabs
// embedded in a pane title from corrupting the flags column. Malformed rows
// (missing fields or non-numeric activity) and control-mode clients are
// skipped — control clients never own focus.
export function parseClients(rows: string, focusEvents: boolean): ClientFocus {
  interface Row {
    activity: number;
    pane: string;
    focused: boolean;
  }
  const parsed: Row[] = [];

  for (const line of rows.split('\n')) {
    if (line.length === 0) continue;
    // Split into at most 6 fields with the 6th being the *remainder* after the
    // 5th tab (matches Rust splitn, so a tab inside the title/flags can't shift
    // the flags column out of reach). flag matching is comma-based so extra tab
    // text folded into flags still yields a clean flag set.
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const activityStr = parts[0]!;
    const pane = parts[3]!;
    const flags = parts.slice(5).join('\t');
    const activity = Number(activityStr);
    if (!Number.isFinite(activity)) continue; // NaN/empty activity — malformed
    const flagList = flags.split(',');
    if (flagList.includes('control-mode')) continue;
    parsed.push({ activity, pane, focused: flagList.includes('focused') });
  }

  const focusedPanes = new Set<string>();
  for (const row of parsed) {
    if (!focusEvents || row.focused) focusedPanes.add(row.pane);
  }

  let activePaneId: string | null = null;
  let maxActivity = -Infinity;
  for (const row of parsed) {
    if (row.activity > maxActivity) {
      maxActivity = row.activity;
      activePaneId = row.pane;
    }
  }

  return { focusedPanes, activePaneId };
}

// Live read: runs `tmux list-clients` and reads the global focus-events option.
// Any tmux failure (no server, spawn error) collapses to an empty focus set and
// a null active pane — callers then suppress nothing, preferring a redundant
// toast over a missed one.
export function readClientFocus(): ClientFocus {
  const out = tmuxOrNull([
    'list-clients',
    '-F',
    '#{client_activity}\t#{client_name}\t#{session_id}\t#{pane_id}\t#{pane_title}\t#{client_flags}',
  ]);
  if (out === null) return { focusedPanes: new Set(), activePaneId: null };
  const focusEvents = getTmuxOption('focus-events') === 'on';
  return parseClients(out, focusEvents);
}
