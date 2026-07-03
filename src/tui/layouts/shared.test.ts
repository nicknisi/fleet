import { describe, expect, test } from 'bun:test';
import { stateIcon, windowLines, type LayoutLines } from './shared.ts';
import { CARD_LAYOUT_MAX_COLS, pickLayout } from './index.ts';
import { AgentStatus } from '../../state/types.ts';

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

describe('stateIcon', () => {
  test('busy icon renders the working glyph in both phases', () => {
    expect(stateIcon(AgentStatus.BUSY, false)).toContain('◉');
    expect(stateIcon(AgentStatus.BUSY, true)).toContain('◉');
  });
  test('non-busy states ignore the pulse phase entirely', () => {
    expect(stateIcon(AgentStatus.PERMIT, true)).toBe(stateIcon(AgentStatus.PERMIT, false));
    expect(stateIcon(AgentStatus.IDLE, true)).toBe(stateIcon(AgentStatus.IDLE, false));
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

  test('boundary: selection just past half shows a top indicator with exact count', () => {
    const w = windowLines(fake(30), 5, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[0]).toContain('↑ 1 more');
    expect(w.lines[9]).toContain('↓ 21 more');
    expect(w.lines[1]).toBe('line1'); // nothing silently hidden
  });

  test('boundary: near-bottom selection shows a bottom indicator with exact count', () => {
    const w = windowLines(fake(30), 25, 9);
    expect(w.lines).toHaveLength(9);
    expect(w.lines[0]).toContain('↑ 22 more');
    expect(w.lines[8]).toContain('↓ 1 more');
  });

  test('indicator counts always sum with visible lines to the total', () => {
    for (let sel = 0; sel < 30; sel++) {
      const w = windowLines(fake(30), sel, 10);
      expect(w.lines.length).toBeLessThanOrEqual(10);
      const top = /↑ (\d+) more/.exec(w.lines[0] ?? '');
      const bot = /↓ (\d+) more/.exec(w.lines[w.lines.length - 1] ?? '');
      const hidden = (top ? parseInt(top[1]!, 10) : 0) + (bot ? parseInt(bot[1]!, 10) : 0);
      const visible = w.lines.length - (top ? 1 : 0) - (bot ? 1 : 0);
      expect(hidden + visible).toBe(30);
      const selVisible = w.states.length === w.lines.length && w.lines.includes(`line${sel}`);
      expect(selVisible).toBe(true);
    }
  });
});
