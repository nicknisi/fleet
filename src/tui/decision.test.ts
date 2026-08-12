import { describe, expect, test } from 'bun:test';
import { renderDecision } from './decision.ts';
import { stripAnsi } from '../terminal/ansi.ts';
import { AgentStatus, type AgentState, type StateDecision } from '../state/types.ts';

// Strip ANSI so assertions target the rendered text, not color codes.
const plain = (lines: string[]): string => stripAnsi(lines.join('\n'));

const baseState = (overrides: Partial<AgentState> = {}): AgentState => ({
  paneId: '%7',
  paneNum: 7,
  session: 'proj',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.PERMIT,
  tool: null,
  project: '~/Developer/proj',
  branch: 'main',
  ports: [],
  ts: 1000,
  agentType: 'claude',
  tracking: 'hook',
  ...overrides,
});

const decision = (overrides: Partial<StateDecision> = {}): StateDecision => ({
  final: AgentStatus.PERMIT,
  candidates: { hook: AgentStatus.BUSY, event: null, scrape: AgentStatus.PERMIT },
  hookTs: 900,
  eventTs: null,
  now: 1000,
  winner: 'scrape',
  reason: 'scraper read an on-screen permission/question prompt — trusted absolutely',
  workingTimeoutFired: false,
  scrapeRuleId: 'permit.yn',
  ...overrides,
});

describe('renderDecision', () => {
  test('renders final state, tracking, candidates, winner, reason, rule id, and timeout', () => {
    const out = plain(renderDecision(baseState({ decision: decision() })));
    expect(out).toContain('State Provenance');
    expect(out).toContain('proj');
    expect(out).toContain('pane %7');
    expect(out).toContain('tracking');
    expect(out).toContain('hook');
    expect(out).toContain('final');
    expect(out).toContain('waiting');
    expect(out).toContain('(PERMIT)');
    // candidate table rows
    expect(out).toContain('scrape');
    expect(out).toContain('rule: permit.yn');
    // decision block
    expect(out).toContain('winner');
    expect(out).toContain('scrape');
    expect(out).toContain('trusted absolutely');
    expect(out).toContain('not fired');
  });

  test('reflects the attached decision exactly (no live re-scrape)', () => {
    const d = decision({ winner: 'event', reason: 'derived from the latest JSONL event', workingTimeoutFired: true });
    const out = plain(renderDecision(baseState({ status: AgentStatus.BUSY, decision: d })));
    expect(out).toContain('winner');
    expect(out).toContain('event');
    expect(out).toContain('derived from the latest JSONL event');
    expect(out).toContain('fired (stale BUSY');
  });

  test('shows timestamps from the decision', () => {
    const out = plain(renderDecision(baseState({ decision: decision({ hookTs: 950, eventTs: 980, now: 1000 }) })));
    expect(out).toContain('now');
    expect(out).toContain('1000');
    expect(out).toContain('950');
    expect(out).toContain('980');
  });

  test('sanitizes control characters and ANSI from dynamic provenance fields', () => {
    const lines = renderDecision(
      baseState({
        agentType: '\u001b[31mclaude\u001b[0m\nspoof',
        decision: decision({ scrapeRuleId: 'permit.yn\nextra-row', reason: 'safe\nfooter-spoof' }),
      }),
    );
    const out = plain(lines);
    expect(out).toContain('claude spoof');
    expect(out).toContain('permit.yn extra-row');
    expect(out).toContain('safe footer-spoof');
    expect(lines.every((line) => !stripAnsi(line).includes('\n'))).toBe(true);
  });

  test('a discovered agent with no decision explains why', () => {
    const out = plain(renderDecision(baseState({ tracking: 'discovery', decision: undefined })));
    expect(out).toContain('discovered agent (no hook)');
  });

  test('a shell pane with no agent explains there is nothing to fuse', () => {
    const out = plain(renderDecision(baseState({ agentType: '', tracking: 'shell', decision: undefined })));
    expect(out).toContain('nothing to fuse');
  });
});
