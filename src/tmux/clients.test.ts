import { describe, expect, test } from 'bun:test';
import { parseClients } from './clients.ts';

// Ports the three test cases from snirt/tmux-agents-mon's focus.rs. The
// popup-discount case is intentionally omitted (that mechanism is not ported);
// see the module doc comment.

describe('parseClients — focus-events ON', () => {
  test('requires the focused flag and ignores control-mode clients', () => {
    const rows = [
      '20\tclient-1\t$1\t%2\twork\tattached,focused,utf8',
      '30\tclient-2\t$2\t%3\twork\tattached,utf8',
      '40\tcontrol\t$3\t%4\tagents-mon\tattached,focused,control-mode,utf8',
    ].join('\n');
    const focus = parseClients(rows, true);

    // client-1 is focused → %2 counts; client-2 lacks the focused flag → %3 does
    // not; the control-mode client is dropped entirely. activePaneId follows the
    // highest-activity *real* client (client-2 → %3), independent of focus.
    expect(focus.focusedPanes).toEqual(new Set(['%2']));
    expect(focus.activePaneId).toBe('%3');
  });
});

describe('parseClients — focus-events OFF', () => {
  test('treats every selected real-client pane as focused', () => {
    const rows = ['20\tclient-1\t$1\t%2\twork\tattached,utf8', '30\tclient-2\t$2\t%3\tagents-mon\tattached,utf8'].join(
      '\n',
    );
    const focus = parseClients(rows, false);

    expect(focus.focusedPanes).toEqual(new Set(['%2', '%3']));
    expect(focus.activePaneId).toBe('%3');
  });
});

describe('parseClients — activity / activePaneId', () => {
  test('activePaneId is the highest-activity real client pane', () => {
    const rows = [
      '5\tclient-1\t$1\t%2\twork\tattached,focused,utf8',
      '99\tclient-2\t$2\t%3\twork\tattached,focused,utf8',
      '50\tcontrol\t$3\t%4\tagents-mon\tattached,focused,control-mode,utf8',
    ].join('\n');
    const focus = parseClients(rows, true);

    expect(focus.activePaneId).toBe('%3'); // client-2 has the max activity (99)
    // control client dropped from focus even though it was focused+flagged.
    expect(focus.focusedPanes).toEqual(new Set(['%2', '%3']));
  });
});

describe('parseClients — robustness', () => {
  test('skips malformed rows and empty input yields an empty result', () => {
    const rows = [
      'notanumber\tclient-1\t$1\t%2\twork\tattached,utf8', // non-numeric activity
      '20\tonly\tthree\tfields', // too few fields
      '', // blank line
    ].join('\n');
    const focus = parseClients(rows, true);
    expect(focus.focusedPanes).toEqual(new Set());
    expect(focus.activePaneId).toBe(null);
  });

  test('splits into at most 6 fields so a tab in the title does not corrupt flags', () => {
    // A title containing a tab must not shift the flags column.
    const rows = ['20\tclient-1\t$1\t%2\tleft\tright\tattached,focused,utf8'].join('\n');
    const focus = parseClients(rows, true);
    expect(focus.focusedPanes).toEqual(new Set(['%2']));
    expect(focus.activePaneId).toBe('%2');
  });
});
