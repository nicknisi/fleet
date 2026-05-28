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

  test('scrape PERMIT overrides hook BUSY with no event', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: AgentStatus.PERMIT,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
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

  test('scrape IDLE does not override a fresh working hook', () => {
    // The scraper can miss Claude's animated spinner between frames. A fresh
    // PreToolUse (working) must not be downgraded to idle by a scraper miss.
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: AgentStatus.IDLE,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('scrape IDLE clears a stale permit', () => {
    // Old "waiting" status file but the screen now shows an idle prompt —
    // the prompt was answered, so the stale PERMIT must clear.
    const result = fuseState({
      hookState: 'waiting',
      hookTs: now - 5,
      eventStatus: null,
      scrapeStatus: AgentStatus.IDLE,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result).toBe(AgentStatus.IDLE);
  });

  test('scrape BUSY wins over an idle hook', () => {
    const result = fuseState({
      hookState: 'done',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: AgentStatus.BUSY,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('working hook past the timeout decays to idle', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 200,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result).toBe(AgentStatus.IDLE);
  });
});
