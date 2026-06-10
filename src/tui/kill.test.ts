import { describe, expect, test } from 'bun:test';
import { canKillSession, renderKillConfirm } from './kill.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (overrides: Partial<AgentState>): AgentState => ({
  paneId: '%42',
  paneNum: 42,
  session: 'test',
  window: 'main',
  claudeName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...overrides,
});

describe('canKillSession', () => {
  test('allows reaping idle, done, shell, and down sessions', () => {
    expect(canKillSession(makeState({ status: AgentStatus.IDLE })).ok).toBe(true);
    expect(canKillSession(makeState({ status: AgentStatus.DONE })).ok).toBe(true);
    expect(canKillSession(makeState({ status: AgentStatus.SHELL })).ok).toBe(true);
    expect(canKillSession(makeState({ status: AgentStatus.DOWN })).ok).toBe(true);
  });

  test('refuses to kill a working agent', () => {
    const result = canKillSession(makeState({ status: AgentStatus.BUSY }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('working');
  });

  test('refuses to kill an agent with a permission prompt', () => {
    const result = canKillSession(makeState({ status: AgentStatus.PERMIT }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('permission');
  });

  test('refuses to kill an agent asking a question', () => {
    const result = canKillSession(makeState({ status: AgentStatus.QUESTION }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('question');
  });
});

describe('renderKillConfirm', () => {
  test('shows the session name and a confirm affordance when killable', () => {
    const lines = renderKillConfirm(makeState({ session: 'dotfiles', status: AgentStatus.DONE }));
    const text = lines.join('\n');
    expect(text).toContain('dotfiles');
    expect(text).toContain('Kill');
    expect(text).toContain('to confirm');
  });

  test('includes the claude name in the label when present', () => {
    const lines = renderKillConfirm(
      makeState({ session: 'dotfiles', claudeName: 'Fix auth bug', status: AgentStatus.IDLE }),
    );
    expect(lines.join('\n')).toContain('Fix auth bug');
  });

  test('shows the gate reason and no confirm affordance when not killable', () => {
    const lines = renderKillConfirm(makeState({ status: AgentStatus.BUSY }));
    const text = lines.join('\n');
    expect(text).toContain('Cannot kill');
    expect(text).toContain('working');
    expect(text).not.toContain('to confirm');
  });
});
