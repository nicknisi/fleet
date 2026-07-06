import { describe, expect, test } from 'bun:test';
import { applySuppression, decideNotifications, type Notification } from './transitions.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

// Minimal AgentState fixture — only paneId, status, agentType, session drive the
// detection logic; the rest are filler the pure function ignores.
function st(paneId: string, status: AgentStatus, session = 'sess', agentType = 'claude'): AgentState {
  return {
    paneId,
    paneNum: Number(paneId.replace('%', '')) || 0,
    session,
    window: '',
    windowId: '@0',
    claudeName: null,
    customName: null,
    status,
    tool: null,
    project: null,
    branch: null,
    ports: [],
    ts: 0,
    agentType,
  };
}

// Minimal Notification fixture for suppression tests.
function notif(paneId: string): Notification {
  return { paneId, agentType: 'claude', label: 'sess', status: AgentStatus.DONE };
}

describe('decideNotifications — detection', () => {
  test('first sight IDLE (no BUSY predecessor) → zero candidates, map advanced', () => {
    const { candidates, previous } = decideNotifications([st('%1', AgentStatus.IDLE)], new Map());
    expect(candidates).toHaveLength(0);
    expect(previous.get('%1')).toBe(AgentStatus.IDLE);
  });

  test('first sight DONE (no BUSY predecessor) → zero candidates', () => {
    const { candidates } = decideNotifications([st('%1', AgentStatus.DONE)], new Map());
    expect(candidates).toHaveLength(0);
  });

  test('BUSY → DONE → one candidate carrying pane/status/label/agentType', () => {
    const arm = decideNotifications([st('%1', AgentStatus.BUSY)], new Map());
    expect(arm.candidates).toHaveLength(0);

    const { candidates } = decideNotifications([st('%1', AgentStatus.DONE, 'authkit')], arm.previous);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      paneId: '%1',
      agentType: 'claude',
      label: 'authkit',
      status: AgentStatus.DONE,
    });
  });

  test('BUSY → IDLE → one candidate (IDLE is a stop state for hook-less discovery)', () => {
    const arm = decideNotifications([st('%1', AgentStatus.BUSY)], new Map());
    const { candidates } = decideNotifications([st('%1', AgentStatus.IDLE)], arm.previous);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe(AgentStatus.IDLE);
  });

  test('BUSY → PERMIT and BUSY → QUESTION both fire', () => {
    const armP = decideNotifications([st('%1', AgentStatus.BUSY)], new Map());
    expect(decideNotifications([st('%1', AgentStatus.PERMIT)], armP.previous).candidates).toHaveLength(1);

    const armQ = decideNotifications([st('%2', AgentStatus.BUSY)], new Map());
    expect(decideNotifications([st('%2', AgentStatus.QUESTION)], armQ.previous).candidates).toHaveLength(1);
  });

  test('BUSY → SHELL / BUSY → DOWN do NOT fire (not stop states)', () => {
    const armS = decideNotifications([st('%1', AgentStatus.BUSY)], new Map());
    expect(decideNotifications([st('%1', AgentStatus.SHELL)], armS.previous).candidates).toHaveLength(0);

    const armD = decideNotifications([st('%2', AgentStatus.BUSY)], new Map());
    expect(decideNotifications([st('%2', AgentStatus.DOWN)], armD.previous).candidates).toHaveLength(0);
  });

  test('staying DONE does not re-fire; DONE → BUSY → DONE re-arms and fires on the second stop', () => {
    // tick 1: DONE with no BUSY predecessor → no candidate
    const t1 = decideNotifications([st('%1', AgentStatus.DONE)], new Map());
    expect(t1.candidates).toHaveLength(0);
    // tick 2: still DONE → no re-fire (previous is DONE, not BUSY)
    const t2 = decideNotifications([st('%1', AgentStatus.DONE)], t1.previous);
    expect(t2.candidates).toHaveLength(0);
    // tick 3: back to BUSY → no candidate (BUSY is not a stop state), arms
    const t3 = decideNotifications([st('%1', AgentStatus.BUSY)], t2.previous);
    expect(t3.candidates).toHaveLength(0);
    // tick 4: DONE again → fires (re-armed)
    const t4 = decideNotifications([st('%1', AgentStatus.DONE)], t3.previous);
    expect(t4.candidates).toHaveLength(1);
  });

  test('two panes transitioning in one tick → two candidates', () => {
    const arm = decideNotifications([st('%1', AgentStatus.BUSY), st('%2', AgentStatus.BUSY)], new Map());
    const { candidates } = decideNotifications(
      [st('%1', AgentStatus.DONE), st('%2', AgentStatus.PERMIT)],
      arm.previous,
    );
    expect(candidates.map((c) => c.paneId).sort()).toEqual(['%1', '%2']);
  });

  test('a pane that vanishes between ticks is dropped from previous and yields no candidate', () => {
    const arm = decideNotifications([st('%1', AgentStatus.BUSY), st('%2', AgentStatus.BUSY)], new Map());
    const { candidates, previous } = decideNotifications([st('%1', AgentStatus.DONE)], arm.previous);
    expect(candidates.map((c) => c.paneId)).toEqual(['%1']);
    expect(previous.has('%2')).toBe(false); // vanished pane drops out, no stale growth
    expect(previous.has('%1')).toBe(true);
  });
});

describe('applySuppression', () => {
  const candidates = [notif('%1'), notif('%2')];

  test('activePaneId === a candidate pane → that one dropped, others kept', () => {
    expect(applySuppression(candidates, '%1', null)).toEqual([notif('%2')]);
  });

  test('activePaneId === fleetPaneId → all dropped (watching the dashboard)', () => {
    expect(applySuppression(candidates, '%9', '%9')).toEqual([]);
  });

  test('watching fleet drops toasts even for a pane that is also a candidate', () => {
    // Focus is fleet's pane, which happens to equal a candidate pane id.
    expect(applySuppression(candidates, '%1', '%1')).toEqual([]);
  });

  test('activePaneId === null → nothing dropped (suppression disabled)', () => {
    expect(applySuppression(candidates, null, null)).toEqual(candidates);
  });

  test('null active pane disables suppression even when fleetPaneId is set', () => {
    expect(applySuppression(candidates, null, '%9')).toEqual(candidates);
  });

  test('active pane not among candidates → all kept', () => {
    expect(applySuppression(candidates, '%7', '%9')).toEqual(candidates);
  });
});
