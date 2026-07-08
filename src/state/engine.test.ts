import { describe, expect, test } from 'bun:test';
import { fuseDiscoveredState, fuseState } from './engine.ts';
import { AgentStatus } from './types.ts';

describe('fuseDiscoveredState', () => {
  const now = Math.floor(Date.now() / 1000);

  test('scraped permission prompt outranks everything — even with no glyph', () => {
    expect(fuseDiscoveredState(false, AgentStatus.PERMIT, now)).toBe(AgentStatus.PERMIT);
  });

  test('scraped question dialog reads QUESTION', () => {
    expect(fuseDiscoveredState(false, AgentStatus.QUESTION, now)).toBe(AgentStatus.QUESTION);
  });

  test('scraped token counter reads BUSY without a spinner glyph', () => {
    expect(fuseDiscoveredState(false, AgentStatus.BUSY, now)).toBe(AgentStatus.BUSY);
  });

  test('spinner glyph alone reads BUSY when the scraper sees nothing', () => {
    expect(fuseDiscoveredState(true, null, now)).toBe(AgentStatus.BUSY);
  });

  test('a scraped bare prompt never demotes a live glyph', () => {
    expect(fuseDiscoveredState(true, AgentStatus.IDLE, now)).toBe(AgentStatus.BUSY);
  });

  test('no glyph and no scrape reads IDLE', () => {
    expect(fuseDiscoveredState(false, null, now)).toBe(AgentStatus.IDLE);
    expect(fuseDiscoveredState(false, AgentStatus.IDLE, now)).toBe(AgentStatus.IDLE);
  });
});

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
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.decision.winner).toBe('hook');
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
    expect(result.status).toBe(AgentStatus.DONE);
    // Only the stale-hook shape reaches the freshness branch.
    expect(result.decision.freshnessEvaluated).toBe(true);
    expect(result.decision.winner).toBe('default');
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
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.decision.winner).toBe('event');
  });

  test('scrape PERMIT always wins', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: AgentStatus.PERMIT,
      scrapeRuleId: 'permit.yn',
      currentStatus: AgentStatus.BUSY,
      currentTs: now - 5,
    });
    expect(result.status).toBe(AgentStatus.PERMIT);
    expect(result.decision.winner).toBe('scrape');
    expect(result.decision.reason).toContain('permission');
    expect(result.decision.scrapeRuleId).toBe('permit.yn');
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
    expect(result.status).toBe(AgentStatus.PERMIT);
    expect(result.decision.winner).toBe('scrape');
  });

  test('DONE never auto-decays — a finished turn waits on you', () => {
    // A turn that ended an hour ago is still waiting for your acknowledgement;
    // it must not silently slip into idle. (This is what hid asked questions.)
    const result = fuseState({
      hookState: 'completed',
      hookTs: now - 3600,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result.status).toBe(AgentStatus.DONE);
    // Live wiring (currentStatus: IDLE, currentTs: 0) never reaches the freshness
    // branch — this is the invariant fleet explain reports as "not evaluated".
    expect(result.decision.freshnessEvaluated).toBe(false);
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
    expect(result.status).toBe(AgentStatus.PERMIT);
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
    expect(result.status).toBe(AgentStatus.BUSY);
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
    expect(result.status).toBe(AgentStatus.IDLE);
    expect(result.decision.winner).toBe('scrape');
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
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.decision.winner).toBe('scrape');
  });

  test('scrape IDLE does not override a fresh DONE', () => {
    // A finished turn sitting at the prompt looks identical on screen to an
    // idle one — the scraper can't tell DONE from IDLE. So a scraped idle
    // prompt must not demote a just-completed turn; DONE means "needs your
    // next prompt" and only time decay should retire it.
    const result = fuseState({
      hookState: 'completed',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: AgentStatus.IDLE,
      currentStatus: AgentStatus.IDLE,
      currentTs: 0,
    });
    expect(result.status).toBe(AgentStatus.DONE);
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
    expect(result.status).toBe(AgentStatus.IDLE);
    expect(result.decision.workingTimeoutFired).toBe(true);
    expect(result.decision.winner).toBe('default');
  });
});
