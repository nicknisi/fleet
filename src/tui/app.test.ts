import { describe, expect, test } from 'bun:test';
import { TuiApp, TuiMode } from './app.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (session: string, status: AgentStatus, paneId?: string): AgentState => ({
  paneId: paneId ?? `%${Math.floor(Math.random() * 1000)}`,
  paneNum: Math.floor(Math.random() * 1000),
  session,
  claudeName: null,
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
