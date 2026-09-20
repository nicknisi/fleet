import { describe, expect, test } from 'bun:test';
import { PI_MANIFEST } from './detection.ts';
import { detectFromPaneContent } from './scraper.ts';
import { fuseState } from './engine.ts';
import { AgentStatus } from './types.ts';

// Sanitized shape captured from a running pi pane. The composer spinner can
// keep animating through a long tool/thinking interval with no new hook write.
const working = [
  'Working on the current task...',
  '╭────────────────────────────────────╮',
  '│ ⠸                                  │',
  '╰────────────────────────────────────╯',
  'model / context / branch',
];

describe('pi live composer detection', () => {
  test('a live composer spinner keeps a stale working hook BUSY', () => {
    const scrape = detectFromPaneContent(working, PI_MANIFEST);
    expect(scrape.status).toBe(AgentStatus.BUSY);
    expect(
      fuseState({
        hookState: 'working',
        hookTs: Math.floor(Date.now() / 1000) - 471,
        eventStatus: null,
        scrapeStatus: scrape.status,
        scrapeRuleId: scrape.ruleId,
      }).status,
    ).toBe(AgentStatus.BUSY);
  });

  test('terminal color sequences do not hide the live spinner row', () => {
    const colored = ['\x1b[90m│\x1b[0m \x1b[33m⠸\x1b[0m     \x1b[90m│\x1b[0m'];
    expect(detectFromPaneContent(colored, PI_MANIFEST).status).toBe(AgentStatus.BUSY);
  });

  test('an idle composer and quoted spinner text do not assert work', () => {
    for (const line of [
      '│ ❯                                  │',
      '│                                    │',
      'Quoted spinner: ⠸',
      '│ the glyph ⠸ appears in this example │',
    ]) {
      expect(detectFromPaneContent([line], PI_MANIFEST).status).toBeNull();
    }
  });

  test('the weak spinner never overrides a structured question or completion', () => {
    for (const [hookState, expected] of [
      ['question', AgentStatus.QUESTION],
      ['permit', AgentStatus.PERMIT],
      ['done', AgentStatus.DONE],
    ] as const) {
      const scrape = detectFromPaneContent(working, PI_MANIFEST);
      expect(
        fuseState({
          hookState,
          hookTs: Math.floor(Date.now() / 1000),
          eventStatus: null,
          scrapeStatus: scrape.status,
          scrapeRuleId: scrape.ruleId,
        }).status,
      ).toBe(expected);
    }
  });
});
