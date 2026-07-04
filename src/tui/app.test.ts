import { describe, expect, test } from 'bun:test';
import { TuiApp, TuiMode } from './app.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (session: string, status: AgentStatus, paneId?: string, window?: string): AgentState => ({
  paneId: paneId ?? `%${Math.floor(Math.random() * 1000)}`,
  paneNum: Math.floor(Math.random() * 1000),
  session,
  window: window ?? 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
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

  test('working sorts above ready, ready above idle', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('ready-s', AgentStatus.DONE),
      makeState('idle-s', AgentStatus.IDLE, '%2'),
      makeState('question-s', AgentStatus.QUESTION, '%3'),
      makeState('working-s', AgentStatus.BUSY, '%4'),
    ]);
    const order = app.sortedStates().map((s) => s.session);
    expect(order).toEqual(['question-s', 'working-s', 'ready-s', 'idle-s']);
  });

  test('filter narrows visible sessions', () => {
    const app = new TuiApp();
    app.updateStates([makeState('dotfiles', AgentStatus.IDLE), makeState('workos-app', AgentStatus.BUSY)]);
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

  test('enterPassthrough / exitPassthrough', () => {
    const app = new TuiApp();
    app.mode = TuiMode.PREVIEW;
    app.enterPassthrough();
    expect(app.mode as string).toBe('PASSTHROUGH');
    app.exitPassthrough();
    expect(app.mode as string).toBe('PREVIEW');
  });

  test('enterSend from preview restores to preview', () => {
    const app = new TuiApp();
    app.mode = TuiMode.PREVIEW;
    app.enterSend();
    expect(app.mode as string).toBe('SEND');
    app.exitSend();
    expect(app.mode as string).toBe('PREVIEW');
  });

  test('enterKillConfirm / exitKillConfirm restores the prior mode from dashboard', () => {
    const app = new TuiApp();
    app.enterKillConfirm();
    expect(app.mode as string).toBe('CONFIRM_KILL');
    app.exitKillConfirm();
    expect(app.mode as string).toBe('DASHBOARD');
  });

  test('enterKillConfirm from preview restores to preview', () => {
    const app = new TuiApp();
    app.mode = TuiMode.PREVIEW;
    app.enterKillConfirm();
    expect(app.mode as string).toBe('CONFIRM_KILL');
    app.exitKillConfirm();
    expect(app.mode as string).toBe('PREVIEW');
  });
});

describe('grouped rows', () => {
  test('group with a PERMIT agent sorts above a DONE-only group regardless of name', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('alpha', AgentStatus.DONE, '%1', 'one'),
      makeState('alpha', AgentStatus.DONE, '%2', 'two'),
      makeState('zeta', AgentStatus.PERMIT, '%3', 'urgent'),
      makeState('zeta', AgentStatus.IDLE, '%4', 'calm'),
    ]);
    const order = app.visibleStates().map((s) => s.session);
    expect(order).toEqual(['zeta', 'zeta', 'alpha', 'alpha']);
  });

  test('within a group, PERMIT renders above DONE; equal statuses order by window name', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('cli', AgentStatus.DONE, '%1', 'bravo'),
      makeState('cli', AgentStatus.PERMIT, '%2', 'zulu'),
      makeState('cli', AgentStatus.DONE, '%3', 'alpha'),
    ]);
    const order = app.visibleStates().map((s) => s.window);
    expect(order).toEqual(['zulu', 'alpha', 'bravo']);
  });

  test('singleton session renders one non-grouped agent row, no header', () => {
    const app = new TuiApp();
    app.updateStates([makeState('solo', AgentStatus.IDLE, '%1', 'editor')]);
    const rows = app.dashboardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ kind: 'agent', state: app.visibleStates()[0]!, grouped: false });
  });

  test('session with 2+ agents renders a header plus grouped rows', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('cli', AgentStatus.PERMIT, '%1', 'one'),
      makeState('cli', AgentStatus.IDLE, '%2', 'two'),
    ]);
    const rows = app.dashboardRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ kind: 'header', session: 'cli', label: 'cli', count: 2, aggregate: AgentStatus.PERMIT });
    expect(rows[1]!.kind).toBe('agent');
    expect(rows[2]!.kind).toBe('agent');
    expect(rows.slice(1).every((r) => r.kind === 'agent' && r.grouped)).toBe(true);
  });

  test('flattened agent rows match visibleStates order exactly', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('cli', AgentStatus.DONE, '%1', 'one'),
      makeState('cli', AgentStatus.BUSY, '%2', 'two'),
      makeState('solo', AgentStatus.PERMIT, '%3', 'main'),
      makeState('projects', AgentStatus.IDLE, '%4', 'a'),
      makeState('projects', AgentStatus.IDLE, '%5', 'b'),
    ]);
    const flattened = app
      .dashboardRows()
      .filter((r) => r.kind === 'agent')
      .map((r) => (r.kind === 'agent' ? r.state.paneId : ''));
    expect(flattened).toEqual(app.visibleStates().map((s) => s.paneId));
  });

  test('filter that excludes all of a session removes its header', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('dotfiles', AgentStatus.IDLE, '%1', 'editor'),
      makeState('dotfiles', AgentStatus.IDLE, '%2', 'shell'),
      makeState('workos-app', AgentStatus.BUSY, '%3', 'api'),
    ]);
    app.setFilter('workos');
    const rows = app.dashboardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('agent');
  });

  test('selectedRowIndex accounts for header lines', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('cli', AgentStatus.PERMIT, '%1', 'one'),
      makeState('cli', AgentStatus.BUSY, '%2', 'two'),
      makeState('solo', AgentStatus.IDLE, '%3', 'main'),
    ]);
    // rows: header(cli), agent(%1), agent(%2), agent(%3 inline)
    expect(app.selectedRowIndex()).toBe(1);
    app.moveDown();
    expect(app.selectedRowIndex()).toBe(2);
    app.moveDown();
    expect(app.selectedRowIndex()).toBe(3);
    expect(app.selectedState()!.paneId).toBe('%3');
  });

  test('selection always lands on an agent, never a header', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('cli', AgentStatus.PERMIT, '%1', 'one'),
      makeState('cli', AgentStatus.BUSY, '%2', 'two'),
    ]);
    for (let i = 0; i < 5; i++) {
      expect(app.selectedState()).not.toBeNull();
      app.moveDown();
    }
  });
});

describe('hover', () => {
  test('updateStates clears hover for vanished panes', () => {
    const app = new TuiApp();
    app.updateStates([makeState('sess', AgentStatus.IDLE, '%1')]);
    app.hoverPaneId = '%1';
    app.updateStates([]);
    expect(app.hoverPaneId).toBeNull();
  });

  test('updateStates keeps hover for surviving panes', () => {
    const app = new TuiApp();
    app.updateStates([makeState('sess', AgentStatus.IDLE, '%1')]);
    app.hoverPaneId = '%1';
    app.updateStates([makeState('sess', AgentStatus.IDLE, '%1')]);
    expect(app.hoverPaneId).toBe('%1');
  });
});

describe('split drag', () => {
  test('listWidth uses splitRatio', () => {
    const app = new TuiApp();
    expect(app.listWidth(100)).toBe(45);
  });

  test('drag updates splitRatio', () => {
    const app = new TuiApp();
    app.startDrag();
    expect(app.dragging).toBe(true);
    app.updateDrag(30, 100);
    expect(app.splitRatio).toBeCloseTo(0.3);
    app.endDrag();
    expect(app.dragging).toBe(false);
    expect(app.listWidth(100)).toBe(30);
  });

  test('drag clamps to min/max', () => {
    const app = new TuiApp();
    app.startDrag();
    app.updateDrag(5, 100);
    expect(app.splitRatio).toBeCloseTo(0.2);
    app.updateDrag(95, 100);
    expect(app.splitRatio).toBeCloseTo(0.8);
    app.endDrag();
  });

  test('updateDrag is no-op when not dragging', () => {
    const app = new TuiApp();
    const before = app.splitRatio;
    app.updateDrag(30, 100);
    expect(app.splitRatio).toBe(before);
  });
});
