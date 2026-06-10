import { describe, expect, test } from 'bun:test';
import { formatTmuxStatus, formatPlainStatus, formatStatusLine, formatAge } from './status.ts';
import { AgentStatus, ACK_ALL_RANGE, type AgentState } from '../state/types.ts';

const makeState = (overrides: Partial<AgentState>): AgentState => ({
  paneId: '%42',
  paneNum: 42,
  session: 'test',
  window: 'main',
  claudeName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...overrides,
});

describe('formatPlainStatus', () => {
  test('shows state and count for a session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT }), makeState({ status: AgentStatus.BUSY, paneId: '%43' })];
    const result = formatPlainStatus(states, 'test');
    expect(result).toContain('PERMIT');
    expect(result).toContain('1');
  });

  test('returns idle 0 for unknown session', () => {
    expect(formatPlainStatus([], 'nonexistent')).toBe('idle 0');
  });
});

describe('formatTmuxStatus', () => {
  test('returns tmux format for waiting session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT })];
    const result = formatTmuxStatus(states, 'test');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('#[');
  });

  test('returns empty for idle session', () => {
    const states = [makeState({ status: AgentStatus.IDLE })];
    expect(formatTmuxStatus(states, 'test')).toBe('');
  });

  test('returns empty for busy session', () => {
    const states = [makeState({ status: AgentStatus.BUSY })];
    expect(formatTmuxStatus(states, 'test')).toBe('');
  });
});

describe('formatAge', () => {
  const now = Math.floor(Date.now() / 1000);
  test('returns "now" for very recent ts', () => {
    expect(formatAge(now)).toBe('now');
    expect(formatAge(now - 4)).toBe('now');
  });
  test('returns seconds under a minute', () => {
    expect(formatAge(now - 5)).toBe('5s');
    expect(formatAge(now - 59)).toBe('59s');
  });
  test('returns minutes under an hour', () => {
    expect(formatAge(now - 60)).toBe('1m');
    expect(formatAge(now - 3599)).toBe('59m');
  });
  test('returns hours under a day', () => {
    expect(formatAge(now - 3600)).toBe('1h');
    expect(formatAge(now - 86399)).toBe('23h');
  });
  test('returns days otherwise', () => {
    expect(formatAge(now - 86400)).toBe('1d');
    expect(formatAge(now - 86400 * 3)).toBe('3d');
  });
});

describe('formatStatusLine', () => {
  test('returns empty string when all idle/shell/down', () => {
    const states = [
      makeState({ status: AgentStatus.IDLE, session: 'a' }),
      makeState({ status: AgentStatus.SHELL, session: 'b', paneId: '%2' }),
      makeState({ status: AgentStatus.DOWN, session: 'c', paneId: '%3' }),
    ];
    expect(formatStatusLine(states)).toBe('');
  });

  test('returns empty string for no states', () => {
    expect(formatStatusLine([])).toBe('');
  });

  test('includes PERMIT/QUESTION/DONE, excludes BUSY/IDLE/SHELL/DOWN', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'permit-s', window: 'permit-w' }),
      makeState({ status: AgentStatus.QUESTION, session: 'question-s', window: 'question-w', paneId: '%2' }),
      makeState({ status: AgentStatus.DONE, session: 'done-s', window: 'done-w', paneId: '%3' }),
      makeState({ status: AgentStatus.BUSY, session: 'busy-s', window: 'busy-w', paneId: '%4' }),
      makeState({ status: AgentStatus.IDLE, session: 'idle-s', window: 'idle-w', paneId: '%5' }),
      makeState({ status: AgentStatus.SHELL, session: 'shell-s', window: 'shell-w', paneId: '%6' }),
      makeState({ status: AgentStatus.DOWN, session: 'down-s', window: 'down-w', paneId: '%7' }),
    ];
    const result = formatStatusLine(states);
    expect(result).toContain('permit-w');
    expect(result).toContain('question-w');
    expect(result).toContain('done-w');
    expect(result).not.toContain('busy-w');
    expect(result).not.toContain('idle-w');
    expect(result).not.toContain('shell-w');
    expect(result).not.toContain('down-w');
  });

  test('sorts PERMIT before QUESTION', () => {
    const states = [
      makeState({ status: AgentStatus.QUESTION, session: 'b-question', window: 'q-win', paneId: '%3' }),
      makeState({ status: AgentStatus.PERMIT, session: 'b-permit', window: 'p-win', paneId: '%4' }),
    ];
    const result = formatStatusLine(states);
    const permitIdx = result.indexOf('p-win');
    const questionIdx = result.indexOf('q-win');
    expect(permitIdx).toBeGreaterThanOrEqual(0);
    expect(permitIdx).toBeLessThan(questionIdx);
  });

  test('formats each entry with icon, bold window name, and age', () => {
    const now = Math.floor(Date.now() / 1000);
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'mysession', window: 'task-window', ts: now - 10 }),
    ];
    const result = formatStatusLine(states);
    // Icon for PERMIT is ⚠ with color #f9e2af
    expect(result).toContain('#[fg=#f9e2af]');
    expect(result).toContain('⚠');
    expect(result).toContain('#[bold]task-window#[nobold]');
    expect(result).toContain('10s');
  });

  test('falls back to the session name when the window is empty', () => {
    const states = [makeState({ status: AgentStatus.PERMIT, session: 'dotfiles', window: '' })];
    expect(formatStatusLine(states)).toContain('#[bold]dotfiles#[nobold]');
  });

  test('falls back to the session name when the window equals the session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT, session: 'dotfiles', window: 'dotfiles' })];
    expect(formatStatusLine(states)).toContain('#[bold]dotfiles#[nobold]');
  });

  test('two same-session agents in different windows render distinguishable chips', () => {
    const states = [
      makeState({ status: AgentStatus.DONE, session: 'cli', window: 'alpha', paneId: '%1' }),
      makeState({ status: AgentStatus.DONE, session: 'cli', window: 'beta', paneId: '%2' }),
    ];
    const result = formatStatusLine(states);
    expect(result).toContain('#[bold]alpha#[nobold]');
    expect(result).toContain('#[bold]beta#[nobold]');
  });

  test('wraps each entry in a clickable range with the pane id', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'a', paneId: '%42' }),
      makeState({ status: AgentStatus.QUESTION, session: 'b', paneId: '%7' }),
    ];
    const result = formatStatusLine(states);
    expect(result).toContain('#[range=user|%42]');
    expect(result).toContain('#[range=user|%7]');
    expect(result).toContain('#[norange]');
    // Two entries -> two range openings and two norange closings
    expect(result.match(/#\[range=user\|/g)?.length).toBe(2);
    expect(result.match(/#\[norange\]/g)?.length).toBe(2);
  });

  test('joins multiple entries with the dim separator', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'a', paneId: '%1' }),
      makeState({ status: AgentStatus.QUESTION, session: 'b', paneId: '%2' }),
    ];
    const result = formatStatusLine(states);
    expect(result).toContain(' #[fg=#45475a]│ ');
  });

  test('uses the window name even when claudeName is set', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'dotfiles', window: 'editor', claudeName: 'Fix auth bug' }),
    ];
    const result = formatStatusLine(states);
    expect(result).toContain('editor');
    expect(result).not.toContain('Fix auth bug');
  });

  test('appends a clickable clear-all chip when a ready agent is present', () => {
    const states = [makeState({ status: AgentStatus.DONE, session: 'done-s', paneId: '%3' })];
    const result = formatStatusLine(states);
    expect(result).toContain(`#[range=user|${ACK_ALL_RANGE}]`);
    expect(result).toContain('clear');
    // The chip trails the agent entry, after a separator.
    expect(result.indexOf('done-s')).toBeLessThan(result.indexOf(ACK_ALL_RANGE));
  });

  test('omits the clear-all chip when nothing is ready', () => {
    const states = [
      makeState({ status: AgentStatus.PERMIT, session: 'permit-s', paneId: '%1' }),
      makeState({ status: AgentStatus.QUESTION, session: 'question-s', paneId: '%2' }),
    ];
    const result = formatStatusLine(states);
    expect(result).not.toContain(ACK_ALL_RANGE);
  });

  test('omits the clear-all chip for an empty bar', () => {
    expect(formatStatusLine([])).not.toContain(ACK_ALL_RANGE);
  });
});
