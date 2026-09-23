import { describe, expect, test } from 'bun:test';
import { answersQuestionInPlace, isClaudeQuestionForm } from './answer.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

// Bottom-of-pane text captured from real Claude Code 2.1.280 in tmux.
const rule = '─'.repeat(60);
const transcript = ['❯ Ask the fixture questions.', '', '● An earlier reply that mentions Esc to cancel.'];
const screens = {
  tabs: [
    ...transcript,
    rule,
    '←  ☐ Colour  ☐ Note  ✔ Submit  →',
    '',
    'Which fixture colour should Fleet select?',
    '',
    '\x1b[36m❯ 1. Red\x1b[39m',
    '     Use the red fixture.',
    '  2. Blue',
    '     Use the blue fixture.',
    '  3. Type something.',
    rule,
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    '',
  ],
  typing: [
    '←  ☒ Colour  ☐ Note  ✔ Submit  →',
    'What note should Fleet attach?',
    '❯ 3. café fixture note',
    rule,
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel',
  ],
  single: [
    ' ☐ Colour',
    'Which fixture colour?',
    '❯ 1. Red',
    '  2. Blue',
    '  3. Type something.',
    rule,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ],
  multiSelect: [
    '←  ☐ Extras  ✔ Submit  →',
    '❯ 1. [ ] Red',
    '  2. [ ] Blue',
    '  3. [ ] Type something',
    '     Submit',
    rule,
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ],
  review: [
    '←  ☒ Colour  ☒ Note  ✔ Submit  →',
    'Review your answers',
    ' ● Which fixture colour should Fleet select?',
    '   → Blue',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ],
};
const notForms = {
  permission: [
    ' Bash command',
    '   mkdir fleet-fixture-dir',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /fixture from this project',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ],
  planApproval: [
    '   Exit plan mode?',
    '    Claude wants to exit plan mode',
    '    ❯ 1. Yes, and switch to default (ask each time) for this session',
    '      2. No',
  ],
  answered: [
    ...screens.review,
    '● User answered Claude’s questions:',
    '  ⎿  · Which fixture colour should Fleet select? → Blue',
    rule,
    '❯ ',
    rule,
    '  ? for shortcuts',
  ],
  transcript,
  empty: [],
};

describe('Claude question form recognition', () => {
  test.each(Object.entries(screens))('recognizes the %s page', (_name, lines) => {
    expect(isClaudeQuestionForm(lines)).toBe(true);
  });

  test.each(Object.entries(notForms))('never treats %s as a question form', (_name, lines) => {
    expect(isClaudeQuestionForm(lines)).toBe(false);
  });
});

describe('rows answered in place', () => {
  const row = (agentType: string, status: AgentState['status']): AgentState => ({
    paneId: '%1',
    paneNum: 1,
    session: 's',
    window: 'w',
    windowId: '@1',
    claudeName: null,
    customName: null,
    status,
    tool: null,
    project: null,
    branch: null,
    ports: [],
    ts: 0,
    agentType,
  });

  test('only an asking Claude row answers in place', () => {
    expect(answersQuestionInPlace(row('claude', AgentStatus.QUESTION))).toBe(true);
    expect(answersQuestionInPlace(row('claude', AgentStatus.PERMIT))).toBe(false);
    expect(answersQuestionInPlace(row('codex', AgentStatus.QUESTION))).toBe(false);
  });
});
