import { describe, expect, test } from 'bun:test';
import { formatTmuxStatus, formatPlainStatus } from './status.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (overrides: Partial<AgentState>): AgentState => ({
  paneId: '%42',
  paneNum: 42,
  session: 'test',
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...overrides,
});

describe('formatPlainStatus', () => {
  test('shows state and count for a session', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT }),
      makeState({ status: AgentStatus.BUSY, paneId: '%43' }),
    ];
    const result = formatPlainStatus(states, 'test');
    expect(result).toContain('PERMIT');
    expect(result).toContain('1');
  });

  test('returns idle 0 for unknown session', () => {
    expect(formatPlainStatus([], 'nonexistent')).toBe('idle 0');
  });
});

describe('formatTmuxStatus', () => {
  test('returns tmux format for waiting session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT })];
    const result = formatTmuxStatus(states, 'test');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('#[');
  });

  test('returns empty for idle session', () => {
    const states = [makeState({ status: AgentStatus.IDLE })];
    expect(formatTmuxStatus(states, 'test')).toBe('');
  });

  test('returns empty for busy session', () => {
    const states = [makeState({ status: AgentStatus.BUSY })];
    expect(formatTmuxStatus(states, 'test')).toBe('');
  });
});
