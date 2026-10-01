import { describe, expect, test } from 'bun:test';
import { detectFromPaneContent, detectFromTitle, refineTitleWithScreen } from './scraper.ts';
import { CODEX_MANIFEST } from './detection.ts';
import { AgentStatus } from './types.ts';
import { resolvePermitKeysFromLines } from './permit-keys.ts';
import { fuseState } from './engine.ts';
import { resolveDiscoveredStatus } from '../agents/discovery.ts';

// The inlined Codex patterns run through the same Phase 2 detector as claude.
// Questions use the distinct default Codex 0.154 footer; approval menus keep
// their existing rules. These tests include the real queued-question frame.
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

const queuedQuestion = [
  '• Working (3m 46s • esc to interrupt)',
  '',
  '• Queued follow-up inputs',
  '  ? 1 question',
  '    shift + ← to answer',
  '',
  '› Ask Codex to do anything',
];

describe('Codex queued questions', () => {
  test('recognizes the styled live capture without changing its preview bytes', () => {
    const lines = [
      '\x1b[1m•\x1b[0m Working (13m • esc to interrupt)',
      '\x1b[2m• \x1b[0mQueued follow-up inputs',
      '\x1b[2m  ? \x1b[0;1m\x1b[38;5;6m1 question\x1b[0m',
      '\x1b[2m    shift + ← to answer\x1b[0m',
      '\x1b[1m›\x1b[0m Ask Codex to do anything',
    ];
    const before = [...lines];
    expect(detectFromPaneContent(lines, CODEX_MANIFEST).status).toBe(AgentStatus.QUESTION);
    expect(() => resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'deny')).toThrow('No current permission dialog');
    expect(lines).toEqual(before);
  });

  test('a queued question wins over concurrent work and question prose', () => {
    const screen = detectFromPaneContent(['Do you want to continue?', ...queuedQuestion], CODEX_MANIFEST);
    expect(screen).toEqual({ status: AgentStatus.QUESTION, ruleId: 'question.queued-follow-up' });
    expect(
      detectFromPaneContent(
        queuedQuestion.map((s) => s.replace('1 question', '2 questions')),
        CODEX_MANIFEST,
      ).status,
    ).toBe(AgentStatus.QUESTION);
  });

  test('active single, multi-question and wrapped answer footers read QUESTION', () => {
    for (const footer of [
      'enter to submit all | tab to add notes | esc to interrupt',
      'enter to submit answer | ←/→ to navigate questions | esc to interrupt',
      'enter to submit all | tab to add notes |\n  esc to interrupt',
    ]) {
      expect(detectFromPaneContent(footer.split('\n'), CODEX_MANIFEST).status).toBe(AgentStatus.QUESTION);
    }
  });

  test.each([' + ', '+'].flatMap((plus) => [`alt${plus}↓`, `shift${plus}→`].map((main) => ({ plus, main }))))(
    'async shortcuts %j distinguish questions from the Action Required title',
    ({ plus, main }) => {
      for (const next of ['', `   shift${plus}← next question`, `\n    shift${plus}← next question`]) {
        const lines = [
          '• Working (7m 38s • esc to interrupt)',
          '• Queued follow-up inputs',
          '  1 of 2',
          'When S gives the permission error, are you opening a question?',
          '› 1. Opening an existing question',
          '  2. Sending a new message',
          ...`  enter submit   ctrl${plus}] skip   ${main} main prompt${next}`.split('\n'),
        ];
        const screen = detectFromPaneContent(lines, CODEX_MANIFEST);
        expect(screen).toEqual({ status: AgentStatus.QUESTION, ruleId: 'question.async-answer' });
        expect(
          refineTitleWithScreen('codex', detectFromTitle('[ ! ] Action Required | Codex', CODEX_MANIFEST), screen),
        ).toEqual(screen);
        expect(() => resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'approve')).toThrow(
          'No current permission dialog',
        );
        expect(() => resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'deny')).toThrow('No current permission dialog');
      }
      const collapsed = queuedQuestion.map((line) => line.replace(' + ', plus));
      expect(detectFromPaneContent(collapsed, CODEX_MANIFEST)).toEqual({
        status: AgentStatus.QUESTION,
        ruleId: 'question.queued-follow-up',
      });
    },
  );

  test('quoted shortcut prose, missing UI structure and old question history do not read QUESTION', () => {
    for (const lines of [
      ['The shortcut is shift + ← to answer.'],
      ['  ? 1 question', '    shift + ← to answer'],
      ['> • Queued follow-up inputs', '>   ? 1 question', '>     shift + ← to answer'],
      [...queuedQuestion, ...Array<string>(16).fill('ordinary output')],
      ['I saw enter to submit all | tab to add notes | esc to interrupt'],
      ['The shortcut is shift+← to answer.'],
      ['> enter submit   ctrl+] skip   alt+↓ main prompt'],
      ['enter submit   ctrl+] skip'],
      ['enter submit   ctrl+] skip   alt+↓ main prompt is the footer I saw'],
      ['> enter submit   ctrl+] skip   shift+→ main prompt'],
      ['enter submit   ctrl+] skip   shift+→ main prompt is the footer I saw'],
      ['enter submit   ctrl+] skip   shift+↓ main prompt'],
    ]) {
      expect(detectFromPaneContent(lines, CODEX_MANIFEST).status).not.toBe(AgentStatus.QUESTION);
    }
  });

  test('Action Required is refined for both discovered and hooked Codex panes', () => {
    const screen = detectFromPaneContent(queuedQuestion, CODEX_MANIFEST);
    const title = refineTitleWithScreen('codex', detectFromTitle('Action Required | Codex', CODEX_MANIFEST), screen);
    expect(title).toEqual(screen);
    expect(
      resolveDiscoveredStatus(
        '%1',
        { glyphWorking: true, scrape: screen.status, title: title.status, focused: false },
        { wasBusy: new Set(), done: new Set() },
        100,
      ),
    ).toBe(AgentStatus.QUESTION);
    expect(
      fuseState({
        hookState: 'working',
        hookTs: Math.floor(Date.now() / 1000),
        eventStatus: null,
        scrapeStatus: title.status,
      }).status,
    ).toBe(AgentStatus.QUESTION);
  });

  test('fresh working titles, real permissions and other agents keep their precedence', () => {
    const screen = detectFromPaneContent(queuedQuestion, CODEX_MANIFEST);
    const working = { status: AgentStatus.BUSY, ruleId: 'busy.title-spinner' };
    const permit = detectFromTitle('Action Required', CODEX_MANIFEST);
    expect(refineTitleWithScreen('codex', working, screen)).toEqual(working);
    expect(refineTitleWithScreen('claude', permit, screen)).toEqual(permit);
    expect(
      refineTitleWithScreen(
        'codex',
        permit,
        detectFromPaneContent(['Press Enter to confirm or Esc to cancel'], CODEX_MANIFEST),
      ),
    ).toEqual(permit);
    expect(
      detectFromPaneContent(['• Working (4m • esc to interrupt)', '› Ask Codex to do anything'], CODEX_MANIFEST).status,
    ).toBe(AgentStatus.BUSY);
  });

  test('a stale permission row cannot send approval or denial keys into a question', () => {
    expect(() => resolvePermitKeysFromLines(queuedQuestion, CODEX_MANIFEST, 'approve')).toThrow(
      'No current permission dialog',
    );
    expect(() => resolvePermitKeysFromLines(queuedQuestion, CODEX_MANIFEST, 'deny')).toThrow(
      'No current permission dialog',
    );
  });
});
