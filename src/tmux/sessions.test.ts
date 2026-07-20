import { describe, expect, test } from 'bun:test';
import { listPanes, parsePanesOutput } from './sessions.ts';

describe('listPanes', () => {
  test('returns array (may be empty if not in tmux)', () => {
    const panes = listPanes();
    expect(Array.isArray(panes)).toBe(true);
  });
});

describe('parsePanesOutput', () => {
  test('parses a synthetic 11-field line, capturing window id, index, and focus', () => {
    const line = ['%3', 'mysession', 'mywindow', '@5', '2', '/home/me/proj', '12345', '1', '1', '1', '✳ Fix bug'].join(
      '\t',
    );
    const panes = parsePanesOutput(line);
    expect(panes).toHaveLength(1);
    const p = panes[0]!;
    expect(p.paneId).toBe('%3');
    expect(p.paneNum).toBe(3);
    expect(p.sessionName).toBe('mysession');
    expect(p.windowName).toBe('mywindow');
    expect(p.windowId).toBe('@5');
    expect(p.windowIndex).toBe(2);
    expect(p.currentPath).toBe('/home/me/proj');
    expect(p.panePid).toBe(12345);
    expect(p.focused).toBe(true);
    expect(p.paneTitle).toBe('✳ Fix bug');
  });

  test('skips a line with fewer than 11 tab fields', () => {
    // An 8-field line (the pre-focus format) is too short and must be dropped,
    // not parsed with a title landing in a focus field.
    const line = ['%1', 'sess', 'win', '@5', '2', '/path', '999', 'title'].join('\t');
    expect(parsePanesOutput(line)).toHaveLength(0);
  });

  test('skips blank lines', () => {
    expect(parsePanesOutput('')).toHaveLength(0);
    expect(parsePanesOutput('\n\n')).toHaveLength(0);
  });

  // focused requires ALL THREE of pane_active, window_active, session_attached:
  // the active pane of the active window of an attached session is the one the
  // user is actually looking at. Any leg missing -> not focused.
  test('focused is false unless pane is active AND window is active AND session is attached', () => {
    const mk = (paneActive: string, windowActive: string, attached: string) =>
      ['%1', 's', 'w', '@1', '0', '/p', '10', paneActive, windowActive, attached, 't'].join('\t');
    expect(parsePanesOutput(mk('1', '1', '1'))[0]!.focused).toBe(true);
    expect(parsePanesOutput(mk('1', '1', '2'))[0]!.focused).toBe(true); // two clients attached still counts
    expect(parsePanesOutput(mk('0', '1', '1'))[0]!.focused).toBe(false); // inactive pane
    expect(parsePanesOutput(mk('1', '0', '1'))[0]!.focused).toBe(false); // background window
    expect(parsePanesOutput(mk('1', '1', '0'))[0]!.focused).toBe(false); // detached session
  });

  test('a stray tab in the pane title does not corrupt the window or focus fields', () => {
    // pane_title is LAST in the format, so an embedded tab spills into trailing
    // (ignored) parts instead of shifting window_id/window_index/focus.
    const line = ['%7', 'sess', 'win', '@9', '4', '/path', '321', '0', '1', '1', '✳ Fix\ttab bug'].join('\t');
    const panes = parsePanesOutput(line);
    expect(panes).toHaveLength(1);
    const p = panes[0]!;
    expect(p.windowId).toBe('@9');
    expect(p.windowIndex).toBe(4);
    expect(p.currentPath).toBe('/path');
    expect(p.panePid).toBe(321);
    expect(p.focused).toBe(false);
  });

  test('parses multiple lines', () => {
    const stdout = [
      ['%1', 's', 'w1', '@1', '0', '/a', '10', '1', '1', '1', 't1'].join('\t'),
      ['%2', 's', 'w2', '@2', '1', '/b', '20', '0', '0', '1', 't2'].join('\t'),
    ].join('\n');
    const panes = parsePanesOutput(stdout);
    expect(panes).toHaveLength(2);
    expect(panes[0]!.windowId).toBe('@1');
    expect(panes[0]!.focused).toBe(true);
    expect(panes[1]!.windowId).toBe('@2');
    expect(panes[1]!.focused).toBe(false);
  });
});
