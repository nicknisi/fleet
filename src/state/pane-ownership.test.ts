import { describe, expect, test } from 'bun:test';
import { refreshStates } from './refresh.ts';
import { AgentStatus, type ResolvedHookStatus } from './types.ts';
import type { PaneInfo } from '../tmux/sessions.ts';

describe('hook ownership after pane reuse', () => {
  const pane: PaneInfo = {
    paneId: '%77746',
    paneNum: 77746,
    panePid: 2000,
    tmuxPid: 1000,
    sessionName: 'current-session',
    windowName: 'codex',
    windowId: '@77746',
    windowIndex: 0,
    currentPath: '/tmp',
    focused: false,
    paneLeft: 0,
    paneTop: 0,
    paneTitle: '',
  };
  const hook = (overrides: Partial<ResolvedHookStatus> = {}): ResolvedHookStatus => ({
    pane: pane.paneId,
    session: pane.sessionName,
    tmux_pid: 1000,
    state: 'working',
    tool: 'current work',
    name: 'Current agent',
    ts: Math.floor(Date.now() / 1000),
    agent: 'codex',
    statusDir: '/nonexistent-fleet-owner-test',
    ...overrides,
  });
  const read = (hooks: ResolvedHookStatus[]) =>
    refreshStates([], {
      panesResult: { ok: true, panes: [pane] },
      hookStatuses: hooks,
    })[0]!;

  test.each([
    { session: 'old-session', tmux_pid: 1000 },
    { session: 'current-session', tmux_pid: 999 },
  ])('newer metadata from another owner cannot beat the live hook (%j)', (owner) => {
    const state = read([hook({ ...owner, agent: 'claude', name: 'Old agent', ts: 9999999999 }), hook()]);
    expect(state.agentType).toBe('codex');
    expect(state.agentName).toBe('Current agent');
    expect(state.tool).toBe('current work');
  });

  test('a stale hook alone cannot claim an unrelated pane', () => {
    const state = read([hook({ session: 'old-session', agent: 'claude', name: 'Old agent' })]);
    expect(state.agentType).toBe('');
    expect(state.agentName).toBeNull();
  });

  test('a current hook retains its name and status', () => {
    const state = read([hook({ agent: 'claude', name: 'Current Claude', state: 'idle' })]);
    expect(state.agentType).toBe('claude');
    expect(state.agentName).toBe('Current Claude');
    expect(state.status).toBe(AgentStatus.IDLE);
  });

  test('legacy hooks without a server PID still need the correct session', () => {
    expect(read([hook({ tmux_pid: 0 })]).agentType).toBe('codex');
    expect(read([hook({ session: 'old-session', tmux_pid: 0 })]).agentType).toBe('');
  });

  test('freshness still selects between hooks belonging to the same live owner', () => {
    const state = read([hook({ ts: 1, name: 'Older name' }), hook({ name: 'Newer name' })]);
    expect(state.agentName).toBe('Newer name');
  });
});
