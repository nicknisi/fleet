import { describe, expect, test } from 'bun:test';
import { renderExplain, runExplain, type ExplainBlock } from './explain.ts';
import { AgentStatus, type AgentState, type StateDecision } from '../state/types.ts';

const now = Math.floor(Date.now() / 1000);

const makeDecision = (o: Partial<StateDecision> = {}): StateDecision => ({
  final: AgentStatus.DONE,
  candidates: { hook: AgentStatus.DONE, event: AgentStatus.DONE, scrape: AgentStatus.IDLE },
  hookTs: now - 12,
  eventTs: now - 12,
  now,
  winner: 'event',
  reason: 'derived from the latest JSONL event',
  workingTimeoutFired: false,
  scrapeRuleId: 'idle.prompt',
  ...o,
});

const makeBlock = (o: Partial<ExplainBlock> = {}): ExplainBlock => ({
  session: 'api',
  paneId: '%42',
  agentType: 'claude',
  statusFile: '~/.cache/claude-status/42.status',
  finalStatus: AgentStatus.DONE,
  decision: makeDecision(),
  snapshot: null,
  scrapeAvailable: true,
  ...o,
});

const makeState = (o: Partial<AgentState> = {}): AgentState => ({
  paneId: '%99',
  paneNum: 99,
  session: 'other',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/dev',
  branch: 'main',
  ports: [],
  ts: now,
  agentType: 'claude',
  ...o,
});

describe('renderExplain', () => {
  test('renders the final label and all three candidate rows', () => {
    const out = renderExplain(makeBlock(), false);
    expect(out).toContain("session 'api'");
    expect(out).toContain('%42');
    expect(out).toContain('ready'); // STATUS_DISPLAY[DONE].label
    expect(out).toContain('(DONE)');
    expect(out).toContain('hook');
    expect(out).toContain('event');
    expect(out).toContain('scrape');
  });

  test('surfaces the winner, reason, and scrape rule id', () => {
    const out = renderExplain(makeBlock(), false);
    expect(out).toContain('winner');
    expect(out).toContain('derived from the latest JSONL event');
    expect(out).toContain('rule: idle.prompt');
  });

  test('annotates that DONE never comes from the scraper', () => {
    const out = renderExplain(makeBlock(), false);
    expect(out).toContain('DONE never comes from scrape');
  });

  test('renders the working-timeout line (not fired)', () => {
    const out = renderExplain(makeBlock(), false);
    expect(out).toContain('working-timeout');
    expect(out).toContain('not fired');
  });

  test('renders the working-timeout line (fired)', () => {
    const out = renderExplain(makeBlock({ decision: makeDecision({ workingTimeoutFired: true }) }), false);
    expect(out).toContain('working-timeout');
    expect(out).toContain('stale BUSY');
    expect(out).not.toContain('not fired');
  });

  test('event candidate renders none when there is no event', () => {
    const out = renderExplain(
      makeBlock({
        decision: makeDecision({
          candidates: { hook: AgentStatus.DONE, event: null, scrape: AgentStatus.IDLE },
          eventTs: null,
        }),
      }),
      false,
    );
    // The event row shows "none" rather than a fabricated status.
    const eventLine = out.split('\n').find((l) => l.trimStart().startsWith('event'))!;
    expect(eventLine).toContain('none');
  });

  test('shell block renders shell and no decision', () => {
    // A true shell pane carries agentType '' (refreshStates sets it honestly).
    const out = renderExplain(
      makeBlock({ agentType: '', finalStatus: AgentStatus.SHELL, decision: null, statusFile: null }),
      false,
    );
    expect(out).toContain('shell');
    expect(out).toContain('no agent hook');
    expect(out).not.toContain('candidates');
    expect(out).not.toContain('winner');
  });

  test('a hookless pane WITH an agentType renders as discovered, not shell', () => {
    // Discovery names the pane's agent but writes no status file, so there is
    // still no decision to trace — but the copy must not call it a plain shell.
    const out = renderExplain(
      makeBlock({ agentType: 'opencode', finalStatus: AgentStatus.PERMIT, decision: null, statusFile: null }),
      false,
    );
    expect(out).toContain('discovered agent');
    expect(out).not.toContain('nothing to fuse');
    expect(out).not.toContain('winner');
  });

  test('--show-snapshot frames the scraped buffer', () => {
    const out = renderExplain(makeBlock({ snapshot: ['● Done!', '', '❯'] }), true);
    expect(out).toContain('┌');
    expect(out).toContain('│ ❯');
    expect(out).toContain('└');
    expect(out).not.toContain('run with --show-snapshot');
  });

  test('--show-snapshot reports scrape unavailable when capture failed', () => {
    const out = renderExplain(makeBlock({ snapshot: null, scrapeAvailable: false }), true);
    expect(out).toContain('scrape unavailable');
    expect(out).not.toContain('┌');
  });
});

describe('runExplain', () => {
  test('unknown session returns 1', () => {
    // No matching pane → returns before any tmux/fs access.
    expect(runExplain('nope', [], [], false)).toBe(1);
  });

  test('session filter misses a differently-named session and returns 1', () => {
    expect(runExplain('nope', [makeState({ session: 'other' })], [], false)).toBe(1);
  });
});
