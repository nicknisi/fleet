import { describe, expect, test } from 'bun:test';
import { fuseState } from './engine.ts';
import { AgentStatus } from './types.ts';

describe('fuseState', () => {
  const now = Math.floor(Date.now() / 1000);

  test('hook state with fresh timestamp wins', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('freshness invariant rejects stale hook data', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 100,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.DONE,
      currentTs: now - 5,
    });
    expect(result).toBe(AgentStatus.DONE);
  });

  test('event layer overrides hook when more specific', () => {
    const result = fuseState({
      hookState: 'completed',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('scrape PERMIT always wins', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: AgentStatus.PERMIT,
      currentStatus: AgentStatus.BUSY,
      currentTs: now - 5,
    });
    expect(result).toBe(AgentStatus.PERMIT);
  });

  test('DONE decays to IDLE after 60s', () => {
    const result = fuseState({
      hookState: 'completed',
      hookTs: now - 65,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result).toBe(AgentStatus.IDLE);
  });

  test('maps waiting to PERMIT', () => {
    const result = fuseState({
      hookState: 'waiting',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
    });
    expect(result).toBe(AgentStatus.PERMIT);
  });
});
