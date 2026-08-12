import { describe, expect, test } from 'bun:test';
import { AgentStatus } from './types.ts';
import { discoveredDecision } from './refresh.ts';

describe('discoveredDecision', () => {
  test('attributes a rule-derived prompt to scrape', () => {
    const decision = discoveredDecision(AgentStatus.PERMIT, false, AgentStatus.PERMIT, 'permit.yn', 100);
    expect(decision.winner).toBe('scrape');
    expect(decision.candidates.scrape).toBe(AgentStatus.PERMIT);
    expect(decision.scrapeRuleId).toBe('permit.yn');
  });

  test('attributes glyph-only BUSY to discovery/default, not a nonexistent scrape rule', () => {
    const decision = discoveredDecision(AgentStatus.BUSY, true, null, null, 100);
    expect(decision.winner).toBe('default');
    expect(decision.candidates.scrape).toBeNull();
    expect(decision.reason).toContain('working glyph');
  });

  test('does not claim a cached idle scrape won over a live working glyph', () => {
    const decision = discoveredDecision(AgentStatus.BUSY, true, AgentStatus.IDLE, 'idle.prompt', 100);
    expect(decision.winner).toBe('default');
    expect(decision.candidates.scrape).toBe(AgentStatus.IDLE);
    expect(decision.reason).toContain('working glyph');
  });
});
