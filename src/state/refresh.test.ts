import { describe, expect, test } from 'bun:test';
import { AgentStatus } from './types.ts';
import { discoveredDecision, mapLimited } from './refresh.ts';

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

describe('mapLimited', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('preserves order and maps every item', async () => {
    const out = await mapLimited([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  test('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimited(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return n;
    });
    expect(peak).toBe(3);
    expect(out).toHaveLength(20);
  });

  test('empty input resolves to empty', async () => {
    expect(await mapLimited([], 8, async (n: number) => n)).toEqual([]);
  });
});
