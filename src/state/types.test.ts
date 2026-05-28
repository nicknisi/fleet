import { describe, expect, test } from 'bun:test';
import {
  AgentStatus,
  statusPriority,
  compareStatus,
  extractClaudeName,
  displayName,
  type AgentState,
} from './types.ts';

describe('statusPriority', () => {
  test('PERMIT is highest priority', () => {
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.QUESTION));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.DONE));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
  });

  test('needs-you states sort above BUSY', () => {
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.QUESTION)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.DONE)).toBeLessThan(statusPriority(AgentStatus.BUSY));
  });

  test('DOWN is lowest priority', () => {
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.SHELL));
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.IDLE));
  });
});

describe('compareStatus', () => {
  test('sorts higher priority first', () => {
    const statuses = [AgentStatus.IDLE, AgentStatus.PERMIT, AgentStatus.BUSY, AgentStatus.DONE];
    statuses.sort(compareStatus);
    expect(statuses).toEqual([AgentStatus.PERMIT, AgentStatus.DONE, AgentStatus.BUSY, AgentStatus.IDLE]);
  });
});

describe('extractClaudeName', () => {
  test('extracts name from ✳ prefix', () => {
    expect(extractClaudeName('✳ Deploy example app')).toBe('Deploy example app');
  });

  test('returns null for non-Claude pane titles', () => {
    expect(extractClaudeName('glootie.local')).toBeNull();
    expect(extractClaudeName('mac')).toBeNull();
  });

  test('returns null for spinner prefixes', () => {
    expect(extractClaudeName('⠂ Review Slack thread')).toBeNull();
    expect(extractClaudeName('⠏ telemetry')).toBeNull();
  });

  test('returns null for empty name after ✳', () => {
    expect(extractClaudeName('✳ ')).toBeNull();
    expect(extractClaudeName('✳')).toBeNull();
  });

  test('trims whitespace', () => {
    expect(extractClaudeName('  ✳ Fix bug  ')).toBe('Fix bug');
  });
});

describe('displayName', () => {
  const base: AgentState = {
    paneId: '%1',
    paneNum: 1,
    session: 'dotfiles',
    claudeName: null,
    status: AgentStatus.IDLE,
    tool: null,
    project: null,
    branch: null,
    ports: [],
    ts: 0,
    agentType: 'claude',
  };

  test('returns claudeName when set', () => {
    expect(displayName({ ...base, claudeName: 'Fix auth bug' })).toBe('Fix auth bug');
  });

  test('falls back to session when no claudeName', () => {
    expect(displayName(base)).toBe('dotfiles');
  });
});
