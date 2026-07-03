import { describe, expect, test } from 'bun:test';
import { TuiApp } from '../app.ts';
import { AgentStatus, type AgentState } from '../../state/types.ts';
import { visibleLength } from '../../terminal/ansi.ts';
import { buildCardLines } from './cards.ts';

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
  test('one agent renders exactly 4 lines with parallel state mapping', () => {
    const app = new TuiApp();
    app.updateStates([state({ status: AgentStatus.PERMIT, tool: 'Bash' })]);
    const built = buildCardLines(app, 34);
    expect(built.lines.length).toBeGreaterThanOrEqual(3); // trailing blank trimmed
    expect(built.states[0]?.paneId).toBe('%1');
    expect(built.states[1]?.paneId).toBe('%1'); // every card line hit-tests to its agent
    expect(built.lines[0]).toContain('api');
    expect(built.lines[1]).toContain('main · claude');
    expect(built.lines[2]).toContain('Bash');
  });

  test('selected card carries the ▌ bar on all content lines', () => {
    const app = new TuiApp();
    app.updateStates([state({})]);
    const built = buildCardLines(app, 34);
    expect(built.lines[0]).toContain('▌');
    expect(built.lines[1]).toContain('▌');
    expect(built.lines[2]).toContain('▌');
  });

  test('multi-agent session renders a separator line before its cards', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1', window: 'one' }), state({ paneId: '%2', window: 'two' })]);
    const built = buildCardLines(app, 34);
    expect(built.lines[0]).toContain('api');
    expect(built.lines[0]).toContain('2');
    expect(built.states[0]).toBeNull();
  });

  test('no line exceeds the requested width', () => {
    const app = new TuiApp();
    app.updateStates([state({ branch: 'feature/very-long-branch-name-here', tool: 'WebFetch' })]);
    for (const line of buildCardLines(app, 30).lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(30);
    }
  });
});
