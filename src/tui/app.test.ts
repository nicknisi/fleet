import { describe, expect, test } from 'bun:test';
import { TuiApp, TuiMode } from './app.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (session: string, status: AgentStatus, paneId?: string): AgentState => ({
  paneId: paneId ?? `%${Math.floor(Math.random() * 1000)}`,
  paneNum: Math.floor(Math.random() * 1000),
  session,
  status,
  tool: null,
  project: `~/Developer/${session}`,
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
});

describe('TuiApp', () => {
  test('sorts sessions by priority', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('idle-session', AgentStatus.IDLE),
      makeState('permit-session', AgentStatus.PERMIT),
      makeState('busy-session', AgentStatus.BUSY),
    ]);
    const sorted = app.sortedStates();
    expect(sorted[0]!.session).toBe('permit-session');
    expect(sorted[1]!.session).toBe('busy-session');
    expect(sorted[2]!.session).toBe('idle-session');
  });

  test('filter narrows visible sessions', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('dotfiles', AgentStatus.IDLE),
      makeState('workos-app', AgentStatus.BUSY),
    ]);
    app.setFilter('dot');
    const visible = app.visibleStates();
    expect(visible.length).toBe(1);
    expect(visible[0]!.session).toBe('dotfiles');
  });

  test('mode transitions', () => {
    const app = new TuiApp();
    expect(app.mode).toBe(TuiMode.DASHBOARD);
    app.mode = TuiMode.PREVIEW;
    expect(app.mode).toBe(TuiMode.PREVIEW);
  });

  test('selection clamps to range', () => {
    const app = new TuiApp();
    app.updateStates([makeState('a', AgentStatus.IDLE)]);
    app.selectedIndex = 5;
    expect(app.selectedState()).not.toBeNull();
  });

  test('summary counts states', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('a', AgentStatus.PERMIT),
      makeState('b', AgentStatus.QUESTION),
      makeState('c', AgentStatus.DONE),
      makeState('d', AgentStatus.BUSY),
    ]);
    const summary = app.summary();
    expect(summary.total).toBe(4);
    expect(summary.permit).toBe(1);
    expect(summary.question).toBe(1);
    expect(summary.done).toBe(1);
  });

  test('moveUp and moveDown', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('a', AgentStatus.IDLE),
      makeState('b', AgentStatus.IDLE),
      makeState('c', AgentStatus.IDLE),
    ]);
    expect(app.selectedIndex).toBe(0);
    app.moveDown();
    expect(app.selectedIndex).toBe(1);
    app.moveDown();
    expect(app.selectedIndex).toBe(2);
    app.moveDown(); // clamp
    expect(app.selectedIndex).toBe(2);
    app.moveUp();
    expect(app.selectedIndex).toBe(1);
  });
});
