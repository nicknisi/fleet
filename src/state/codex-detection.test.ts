import { describe, expect, test } from 'bun:test';
import { detectFromPaneContent } from './scraper.ts';
import { CODEX_MANIFEST } from './detection.ts';
import { AgentStatus } from './types.ts';

// The inlined Codex patterns run through the same Phase 2 detector as claude.
// Every prompt rule is PERMIT (Codex has no Notification hook and no distinct
// question dialog, so QUESTION is not currently sourced for it); BUSY/DONE come
// from the hook, not scraping.
describe('CODEX_MANIFEST classification', () => {
  const permitCases: Array<{ name: string; lines: string[]; ruleId: string }> = [
    { name: 'allow command?', lines: ['Allow command?'], ruleId: 'permit.allow' },
    {
      name: 'press enter to confirm',
      lines: ['Press Enter to confirm or Esc to cancel'],
      ruleId: 'permit.confirm',
    },
    { name: '[y/n]', lines: ['Overwrite file? [y/n]'], ruleId: 'permit.yn' },
    { name: 'do you want to', lines: ['Do you want to apply this patch?'], ruleId: 'permit.do-you-want' },
  ];

  for (const c of permitCases) {
    test(`${c.name} => PERMIT (${c.ruleId})`, () => {
      const r = detectFromPaneContent(c.lines, CODEX_MANIFEST);
      expect(r.status).toBe(AgentStatus.PERMIT);
      expect(r.ruleId).toBe(c.ruleId);
    });
  }

  test('bare prompt marker => IDLE', () => {
    const r = detectFromPaneContent(['patch applied.', '', '❯'], CODEX_MANIFEST);
    expect(r.status).toBe(AgentStatus.IDLE);
    expect(r.ruleId).toBe('idle.prompt');
  });

  test('unrecognized content => null', () => {
    const r = detectFromPaneContent(['$ ls', 'README.md', 'src'], CODEX_MANIFEST);
    expect(r.status).toBeNull();
    expect(r.ruleId).toBeNull();
  });

  test('first match wins on a line matching several rules', () => {
    // Matches permit.allow, permit.yn AND permit.do-you-want; the earliest
    // rule (permit.allow) must win.
    const r = detectFromPaneContent(['Do you want to allow command? [y/n]'], CODEX_MANIFEST);
    expect(r.status).toBe(AgentStatus.PERMIT);
    expect(r.ruleId).toBe('permit.allow');
  });
});
