import { describe, expect, test } from 'bun:test';
import { fuseDiscoveredState, fuseState, hookStateForStatus } from './engine.ts';
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

describe('hookStateForStatus', () => {
  test('round-trips every status the write path persists', () => {
    // The inverse of mapHookState for the states verifyPaneState writes.
    expect(hookStateForStatus(AgentStatus.PERMIT)).toBe('permit');
    expect(hookStateForStatus(AgentStatus.QUESTION)).toBe('question');
    expect(hookStateForStatus(AgentStatus.DONE)).toBe('done');
    expect(hookStateForStatus(AgentStatus.BUSY)).toBe('working');
    expect(hookStateForStatus(AgentStatus.IDLE)).toBe('idle');
    expect(hookStateForStatus(AgentStatus.SHELL)).toBe('idle');
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
    });
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.decision.winner).toBe('hook');
  });

  test('event layer overrides hook when more specific', () => {
    const result = fuseState({
      hookState: 'completed',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: null,
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
    });
    expect(result.status).toBe(AgentStatus.DONE);
  });

  test('maps waiting to PERMIT', () => {
    const result = fuseState({
      hookState: 'waiting',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: null,
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
    });
    expect(result.status).toBe(AgentStatus.DONE);
  });

  test('working hook past the timeout decays to idle', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 200,
      eventStatus: null,
      scrapeStatus: null,
    });
    expect(result.status).toBe(AgentStatus.IDLE);
    expect(result.decision.workingTimeoutFired).toBe(true);
    expect(result.decision.winner).toBe('default');
  });

  test('a fresh event BUSY is not decayed by a stale hook ts', () => {
    // Decay anchors to the freshest activity signal: a long single tool run
    // keeps the event ts fresh even when the status file has gone stale.
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 200,
      eventStatus: AgentStatus.BUSY,
      eventTs: now - 10,
      scrapeStatus: null,
    });
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.decision.workingTimeoutFired).toBe(false);
  });

  test('event BUSY with a stale event ts still decays', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 300,
      eventStatus: AgentStatus.BUSY,
      eventTs: now - 200,
      scrapeStatus: null,
    });
    expect(result.status).toBe(AgentStatus.IDLE);
    expect(result.decision.workingTimeoutFired).toBe(true);
  });
});
