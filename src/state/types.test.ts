import { describe, expect, test } from 'bun:test';
import { AgentStatus, statusPriority, compareStatus } from './types.ts';

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
