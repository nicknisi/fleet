import { describe, expect, test } from 'bun:test';
import { windowLines, type LayoutLines } from './shared.ts';
import { CARD_LAYOUT_MAX_COLS, pickLayout } from './index.ts';

const fake = (n: number): LayoutLines => ({
  lines: Array.from({ length: n }, (_, i) => `line${i}`),
  states: Array.from({ length: n }, () => null),
});

describe('pickLayout', () => {
  test('narrow is cards, wide is table', () => {
    expect(pickLayout(CARD_LAYOUT_MAX_COLS - 1)).toBe('cards');
    expect(pickLayout(CARD_LAYOUT_MAX_COLS)).toBe('table');
    expect(pickLayout(200)).toBe('table');
  });
});

describe('windowLines', () => {
  test('short content passes through without indicators', () => {
    const w = windowLines(fake(5), 0, 10);
    expect(w.lines).toHaveLength(5);
    expect(w.lines.join('')).not.toContain('more');
  });

  test('scrolled-down content shows a top indicator counting hidden lines', () => {
    const w = windowLines(fake(30), 29, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[0]).toContain('↑');
    expect(w.lines[0]).toContain('more');
    expect(w.states[0]).toBeNull();
  });

  test('content below shows a bottom indicator', () => {
    const w = windowLines(fake(30), 0, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[9]).toContain('↓ 21 more');
  });

  test('middle position shows both indicators and stays within maxRows', () => {
    const w = windowLines(fake(30), 15, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[0]).toContain('↑');
    expect(w.lines[9]).toContain('↓');
  });
});
