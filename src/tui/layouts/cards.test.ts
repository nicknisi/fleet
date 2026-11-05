import { describe, expect, test } from 'bun:test';
import { TuiApp } from '../app.ts';
import { AgentStatus, type AgentState } from '../../state/types.ts';
import { visibleLength } from '../../terminal/ansi.ts';
import { buildCardLines, splitGlyph } from './cards.ts';

const state = (over: Partial<AgentState>): AgentState => ({
  paneId: '%1',
  paneNum: 1,
  session: 'api',
  window: 'api',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/api',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...over,
});

describe('buildCardLines', () => {
  test('lone agent gets a session header, then one row plus a detail line when selected', () => {
    const app = new TuiApp();
    app.updateStates([state({ status: AgentStatus.PERMIT, tool: 'Bash', window: 'editor' })]);
    const built = buildCardLines(app, 34);
    expect(built.lines[0]).toContain('api');
    expect(built.states[0]).toBeNull();
    expect(built.lines[1]).toContain('✳ editor');
    expect(built.lines[1]).toContain('⚠');
    expect(built.lines[2]).toContain('main · claude · Bash');
    expect(built.states[1]?.paneId).toBe('%1');
    expect(built.states[2]?.paneId).toBe('%1'); // detail line hit-tests to its agent
  });

  test('unselected agents are one line; idle rows have no right marker', () => {
    const app = new TuiApp();
    app.updateStates([
      state({ paneId: '%1', window: 'one', status: AgentStatus.BUSY }),
      state({ paneId: '%2', window: 'two', agentType: 'pi' }),
    ]);
    const built = buildCardLines(app, 34);
    // header, selected row + detail, unselected row
    expect(built.lines.length).toBe(4);
    expect(built.lines[3]).toContain('π two');
    expect(built.lines[3]!.trimEnd().endsWith('two')).toBe(true);
  });

  test('groups are separated by a blank line', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1' }), state({ paneId: '%2', session: 'web', window: 'web' })]);
    const built = buildCardLines(app, 34);
    const blank = built.lines.indexOf('');
    expect(blank).toBeGreaterThan(0);
    expect(built.states[blank]).toBeNull();
    expect(built.lines[blank + 1]).toContain('web');
  });

  test('without color the selected row is marked with ›', () => {
    const app = new TuiApp();
    app.updateStates([state({})]);
    expect(buildCardLines(app, 34).lines[1]!.startsWith('›')).toBe(true);
  });

  test('agents sharing a window get a split glyph; a solo agent gets none', () => {
    const app = new TuiApp();
    app.updateStates([
      state({ paneId: '%1', window: 'left', paneLeft: 0, paneTop: 0 }),
      state({ paneId: '%2', window: 'right', paneLeft: 80, paneTop: 0, agentType: 'pi' }),
      state({ paneId: '%3', window: 'solo', windowId: '@2', agentType: 'codex' }),
    ]);
    const lines = buildCardLines(app, 34).lines;
    expect(lines.find((l) => l.includes('left'))).toContain('◧ ✳ left');
    expect(lines.find((l) => l.includes('right'))).toContain('◨ π right');
    expect(lines.find((l) => l.includes('solo'))).toMatch(/^ {3}◆ solo/);
  });

  test('no line exceeds the requested width', () => {
    const app = new TuiApp();
    app.updateStates([
      state({ branch: 'feature/very-long-branch-name-here', tool: 'WebFetch', status: AgentStatus.DONE }),
      state({ paneId: '%2', session: 'a-very-long-session-name-for-the-header', agentType: 'mystery' }),
    ]);
    for (const line of buildCardLines(app, 30).lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(30);
    }
  });
});

describe('splitGlyph', () => {
  const a = state({ paneId: '%1', paneLeft: 0, paneTop: 0 });
  test('stacked panes', () => {
    const b = state({ paneId: '%2', paneLeft: 0, paneTop: 20 });
    expect(splitGlyph(a, [a, b])).toBe('⬒');
    expect(splitGlyph(b, [a, b])).toBe('⬓');
  });
  test('3+ agents, or unknown position, fall back to ⊞', () => {
    const b = state({ paneId: '%2', paneLeft: 40, paneTop: 0 });
    const c = state({ paneId: '%3', paneLeft: 80, paneTop: 0 });
    expect(splitGlyph(a, [a, b, c])).toBe('⊞');
    expect(splitGlyph(a, [a, state({ paneId: '%2' })])).toBe('⊞');
  });
  test('alone in the window', () => {
    expect(splitGlyph(a, [a])).toBe(' ');
  });
});
