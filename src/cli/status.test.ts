import { describe, expect, test } from 'bun:test';
import { formatTmuxStatus, formatPlainStatus, formatStatusLine, formatAge, windowColorArgs } from './status.ts';
import { AgentStatus, ACK_ALL_RANGE, type AgentState } from '../state/types.ts';

const makeState = (overrides: Partial<AgentState>): AgentState => ({
  paneId: '%42',
  paneNum: 42,
  session: 'test',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
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
    // Icon for PERMIT is ⚠ in the terminal's yellow (theme-aware named color)
    expect(result).toContain('#[fg=yellow]');
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
    expect(result).toContain(' #[fg=brightblack]│ ');
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

describe('windowColorArgs', () => {
  // Find the single arg list that targets a given window id (its position
  // differs between the set and unset forms, so match by membership).
  const argsFor = (all: string[][], windowId: string): string[] | undefined =>
    all.find((a) => a.includes(windowId));

  test('groups by window and reduces to the worst state: PERMIT window set, IDLE window unset', () => {
    const args = windowColorArgs([
      makeState({ windowId: '@1', status: AgentStatus.PERMIT, paneId: '%1' }),
      makeState({ windowId: '@2', status: AgentStatus.IDLE, paneId: '%2' }),
    ]);
    expect(argsFor(args, '@1')).toEqual(['set', '-w', '-t', '@1', '@fleet_state', 'yellow']);
    expect(argsFor(args, '@2')).toEqual(['set', '-w', '-u', '-t', '@2', '@fleet_state']);
  });

  test('maps PERMIT→yellow, QUESTION→magenta, DONE→green', () => {
    const args = windowColorArgs([
      makeState({ windowId: '@1', status: AgentStatus.PERMIT, paneId: '%1' }),
      makeState({ windowId: '@2', status: AgentStatus.QUESTION, paneId: '%2' }),
      makeState({ windowId: '@3', status: AgentStatus.DONE, paneId: '%3' }),
    ]);
    expect(argsFor(args, '@1')).toEqual(['set', '-w', '-t', '@1', '@fleet_state', 'yellow']);
    expect(argsFor(args, '@2')).toEqual(['set', '-w', '-t', '@2', '@fleet_state', 'magenta']);
    expect(argsFor(args, '@3')).toEqual(['set', '-w', '-t', '@3', '@fleet_state', 'green']);
  });

  test('an idle-only window emits the unset form, never a colored set (data shadow)', () => {
    const args = windowColorArgs([makeState({ windowId: '@7', status: AgentStatus.IDLE })]);
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual(['set', '-w', '-u', '-t', '@7', '@fleet_state']);
  });

  test('reduce-then-classify: BUSY+DONE in one window reduces to BUSY → unset (BUSY masks DONE)', () => {
    // PRIORITY ranks BUSY above DONE, so the window reduces to BUSY, which is not
    // in the attention set → unset. Documents the intentional mask; guards
    // against a regression that would start tinting working windows.
    const args = windowColorArgs([
      makeState({ windowId: '@1', status: AgentStatus.BUSY, paneId: '%1' }),
      makeState({ windowId: '@1', status: AgentStatus.DONE, paneId: '%2' }),
    ]);
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual(['set', '-w', '-u', '-t', '@1', '@fleet_state']);
  });

  test('a window with multiple attention agents tints by the most urgent (PERMIT over DONE)', () => {
    const args = windowColorArgs([
      makeState({ windowId: '@1', status: AgentStatus.DONE, paneId: '%1' }),
      makeState({ windowId: '@1', status: AgentStatus.PERMIT, paneId: '%2' }),
    ]);
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual(['set', '-w', '-t', '@1', '@fleet_state', 'yellow']);
  });

  test('every distinct window id produces exactly one arg list', () => {
    const args = windowColorArgs([
      makeState({ windowId: '@1', status: AgentStatus.PERMIT, paneId: '%1' }),
      makeState({ windowId: '@1', status: AgentStatus.IDLE, paneId: '%2' }),
      makeState({ windowId: '@2', status: AgentStatus.DONE, paneId: '%3' }),
    ]);
    expect(args).toHaveLength(2);
    expect(argsFor(args, '@1')).toBeDefined();
    expect(argsFor(args, '@2')).toBeDefined();
  });

  test('a state with an empty window id is skipped (graceful degrade, no malformed set)', () => {
    const args = windowColorArgs([
      makeState({ windowId: '', status: AgentStatus.PERMIT, paneId: '%1' }),
      makeState({ windowId: '@2', status: AgentStatus.QUESTION, paneId: '%2' }),
    ]);
    expect(args).toHaveLength(1);
    expect(argsFor(args, '@2')).toEqual(['set', '-w', '-t', '@2', '@fleet_state', 'magenta']);
    // No arg list contains an empty target.
    expect(args.some((a) => a.includes(''))).toBe(false);
  });

  test('returns no args for an empty state list', () => {
    expect(windowColorArgs([])).toHaveLength(0);
  });
});
