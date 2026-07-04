import { describe, expect, test } from 'bun:test';
import { listPanes, parsePanesOutput } from './sessions.ts';

describe('listPanes', () => {
  test('returns array (may be empty if not in tmux)', () => {
    const panes = listPanes();
    expect(Array.isArray(panes)).toBe(true);
  });
});

describe('parsePanesOutput', () => {
  test('parses a synthetic 8-field line, capturing window id and index', () => {
    const line = ['%3', 'mysession', 'mywindow', '@5', '2', '/home/me/proj', '12345', '✳ Fix bug'].join('\t');
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
    expect(p.paneTitle).toBe('✳ Fix bug');
  });

  test('skips a line with fewer than 8 tab fields', () => {
    // A 6-field line (the old format) is too short and must be dropped, not
    // parsed with undefined window fields.
    const line = ['%1', 'sess', 'win', '/path', '999', 'title'].join('\t');
    expect(parsePanesOutput(line)).toHaveLength(0);
  });

  test('skips blank lines', () => {
    expect(parsePanesOutput('')).toHaveLength(0);
    expect(parsePanesOutput('\n\n')).toHaveLength(0);
  });

  test('a stray tab in the pane title does not corrupt the window id', () => {
    // pane_title is LAST in the format, so an embedded tab spills into trailing
    // (ignored) parts instead of shifting window_id/window_index.
    const line = ['%7', 'sess', 'win', '@9', '4', '/path', '321', '✳ Fix\ttab bug'].join('\t');
    const panes = parsePanesOutput(line);
    expect(panes).toHaveLength(1);
    const p = panes[0]!;
    expect(p.windowId).toBe('@9');
    expect(p.windowIndex).toBe(4);
    expect(p.currentPath).toBe('/path');
    expect(p.panePid).toBe(321);
  });

  test('parses multiple lines', () => {
    const stdout = [
      ['%1', 's', 'w1', '@1', '0', '/a', '10', 't1'].join('\t'),
      ['%2', 's', 'w2', '@2', '1', '/b', '20', 't2'].join('\t'),
    ].join('\n');
    const panes = parsePanesOutput(stdout);
    expect(panes).toHaveLength(2);
    expect(panes[0]!.windowId).toBe('@1');
    expect(panes[1]!.windowId).toBe('@2');
  });
});
