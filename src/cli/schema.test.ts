import { describe, expect, test } from 'bun:test';
import {
  SCHEMA_VERSION,
  isAgent,
  toAgentView,
  classifyOutcome,
  outcomeExitCode,
  buildEnvelope,
  type Outcome,
} from './schema.ts';
import { EXIT } from './exit-codes.ts';
import { AgentStatus, type AgentState, type StateDecision } from '../state/types.ts';

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
  ts: 1000,
  agentType: 'claude',
  ...overrides,
});

const decision = (over: Partial<StateDecision> = {}): StateDecision => ({
  final: AgentStatus.DONE,
  candidates: { hook: AgentStatus.IDLE, event: AgentStatus.DONE, scrape: null },
  hookTs: 900,
  eventTs: 950,
  now: 1000,
  winner: 'event',
  reason: 'derived from the latest JSONL event',
  workingTimeoutFired: false,
  scrapeRuleId: null,
  ...over,
});

describe('isAgent', () => {
  test('a pane with an agent type is an agent', () => {
    expect(isAgent(makeState({ agentType: 'claude' }))).toBe(true);
  });

  test('a shell pane (empty agent type) is not an agent', () => {
    expect(isAgent(makeState({ agentType: '' }))).toBe(false);
  });
});

describe('toAgentView', () => {
  test('flattens tmux identity, labels, and derived flags', () => {
    const v = toAgentView(makeState({ status: AgentStatus.PERMIT }));
    expect(v.pane).toBe('%42');
    expect(v.windowId).toBe('@1');
    expect(v.session).toBe('test');
    expect(v.agentType).toBe('claude');
    expect(v.tracking).toBe('hook');
    expect(v.timestampKind).toBe('state_change');
    expect(v.status).toBe(AgentStatus.PERMIT);
    expect(v.needsAttention).toBe(true);
  });

  test('needsAttention is true only for PERMIT/QUESTION/DONE', () => {
    expect(toAgentView(makeState({ status: AgentStatus.BUSY })).needsAttention).toBe(false);
    expect(toAgentView(makeState({ status: AgentStatus.IDLE })).needsAttention).toBe(false);
    expect(toAgentView(makeState({ status: AgentStatus.QUESTION })).needsAttention).toBe(true);
    expect(toAgentView(makeState({ status: AgentStatus.DONE })).needsAttention).toBe(true);
  });

  test('provenance fields are null when no decision is attached', () => {
    const v = toAgentView(makeState({}));
    expect(v.source).toBeNull();
    expect(v.candidates).toBeNull();
    expect(v.scrapeRuleId).toBeNull();
    expect(v.reason).toBeNull();
    expect(v.hookTs).toBeNull();
    expect(v.eventTs).toBeNull();
    expect(v.workingTimeoutFired).toBe(false);
  });

  test('discovered agents expose observed-time semantics', () => {
    const v = toAgentView(makeState({ tracking: 'discovery' }));
    expect(v.tracking).toBe('discovery');
    expect(v.timestampKind).toBe('observed');
  });

  test('provenance fields flow through from the fusion decision', () => {
    const v = toAgentView(
      makeState({
        status: AgentStatus.PERMIT,
        decision: decision({ winner: 'scrape', scrapeRuleId: 'permit.yn', reason: 'scraped prompt' }),
      }),
    );
    expect(v.source).toBe('scrape');
    expect(v.scrapeRuleId).toBe('permit.yn');
    expect(v.reason).toBe('scraped prompt');
    expect(v.candidates).toEqual({ hook: AgentStatus.IDLE, event: AgentStatus.DONE, scrape: null });
    expect(v.hookTs).toBe(900);
    expect(v.eventTs).toBe(950);
  });

  test('git metadata and workmux enrichment flow through additively (null by default)', () => {
    const v = toAgentView(makeState({}));
    expect(v.git).toBeNull();
    expect(v.workmux).toBeNull();
    expect(v.repoSiblingCount).toBe(0);
    // Existing project/branch fields are preserved.
    expect(v.branch).toBe('main');
    expect(v.project).toBe('~/Developer/test');
  });

  test('git metadata is passed through when present', () => {
    const git = {
      repoId: '/r/.git',
      commonDir: '/r/.git',
      worktreeRoot: '/r',
      branch: 'feat',
      detached: false,
      head: 'abc',
      dirty: true,
      staged: 1,
      unstaged: 2,
      untracked: 3,
      ahead: 4,
      behind: 5,
      upstream: 'origin/feat',
      diffstat: { files: 2, added: 9, removed: 1 },
    };
    const v = toAgentView(makeState({ git }), 2);
    expect(v.git).toEqual(git);
    expect(v.repoSiblingCount).toBe(2);
  });
});

describe('buildEnvelope repo siblings', () => {
  const meta = (worktreeRoot: string) => ({
    repoId: '/r/.git',
    commonDir: '/r/.git',
    worktreeRoot,
    branch: 'main',
    detached: false,
    head: 'abc',
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    upstream: null,
    diffstat: { files: 0, added: 0, removed: 0 },
  });

  test('computes sibling counts across the reported agents', () => {
    const env = buildEnvelope({
      agents: [makeState({ paneId: '%1', git: meta('/r/a') }), makeState({ paneId: '%2', git: meta('/r/b') })],
      outcome: 'ok',
      selector: null,
      now: 1,
    });
    expect(env.agents.every((a) => a.repoSiblingCount === 2)).toBe(true);
  });
});

describe('classifyOutcome', () => {
  test('ok: tmux up, agents present, no selector', () => {
    expect(classifyOutcome({ tmuxOk: true, totalAgents: 2, selectorApplied: false, matchedAgents: 2 })).toBe('ok');
  });

  test('no_agents: tmux up but zero agents', () => {
    expect(classifyOutcome({ tmuxOk: true, totalAgents: 0, selectorApplied: false, matchedAgents: 0 })).toBe(
      'no_agents',
    );
  });

  test('no_match: selector applied, agents exist, none matched', () => {
    expect(classifyOutcome({ tmuxOk: true, totalAgents: 3, selectorApplied: true, matchedAgents: 0 })).toBe('no_match');
  });

  test('tmux_unavailable: tmux down and no cached agents', () => {
    expect(classifyOutcome({ tmuxOk: false, totalAgents: 0, selectorApplied: false, matchedAgents: 0 })).toBe(
      'tmux_unavailable',
    );
  });

  test('stale_data: tmux down but a prior snapshot has agents', () => {
    expect(classifyOutcome({ tmuxOk: false, totalAgents: 2, selectorApplied: false, matchedAgents: 2 })).toBe(
      'stale_data',
    );
  });

  test('tmux-down precedence: a dead tmux outranks a selector miss', () => {
    expect(classifyOutcome({ tmuxOk: false, totalAgents: 0, selectorApplied: true, matchedAgents: 0 })).toBe(
      'tmux_unavailable',
    );
  });

  test('ok when a selector matched at least one agent', () => {
    expect(classifyOutcome({ tmuxOk: true, totalAgents: 3, selectorApplied: true, matchedAgents: 1 })).toBe('ok');
  });
});

describe('outcomeExitCode', () => {
  test('non-failure outcomes still exit 0 (they produced valid JSON)', () => {
    expect(outcomeExitCode('ok')).toBe(EXIT.OK);
    expect(outcomeExitCode('no_agents')).toBe(EXIT.OK);
    expect(outcomeExitCode('stale_data')).toBe(EXIT.OK);
  });

  test('script-actionable failures map to their own codes', () => {
    expect(outcomeExitCode('no_match')).toBe(EXIT.NO_MATCH);
    expect(outcomeExitCode('ambiguous')).toBe(EXIT.AMBIGUOUS);
    expect(outcomeExitCode('tmux_unavailable')).toBe(EXIT.TMUX_UNAVAILABLE);
  });

  test('unknown is a generic usage error', () => {
    expect(outcomeExitCode('unknown')).toBe(EXIT.USAGE);
  });

  test('every outcome maps to a defined exit code', () => {
    const outcomes: Outcome[] = [
      'ok',
      'no_agents',
      'no_match',
      'ambiguous',
      'tmux_unavailable',
      'stale_data',
      'unknown',
    ];
    for (const o of outcomes) expect(typeof outcomeExitCode(o)).toBe('number');
  });
});

describe('buildEnvelope', () => {
  test('wraps agents in the versioned envelope with count and selector', () => {
    const env = buildEnvelope({
      agents: [makeState({ paneId: '%1' }), makeState({ paneId: '%2' })],
      outcome: 'ok',
      selector: 'api',
      now: 1234,
    });
    expect(env.schema).toBe(SCHEMA_VERSION);
    expect(env.outcome).toBe('ok');
    expect(env.queriedAt).toBe(1234);
    expect(env.selector).toBe('api');
    expect(env.count).toBe(2);
    expect(env.agents).toHaveLength(2);
  });

  test('an empty roster is a valid envelope (count 0, null selector)', () => {
    const env = buildEnvelope({ agents: [], outcome: 'no_agents', selector: null, now: 1 });
    expect(env.count).toBe(0);
    expect(env.selector).toBeNull();
    expect(env.agents).toEqual([]);
  });

  test('round-trips through JSON.stringify/parse', () => {
    const env = buildEnvelope({ agents: [makeState({})], outcome: 'ok', selector: null, now: 5 });
    const parsed = JSON.parse(JSON.stringify(env));
    expect(parsed.schema).toBe(SCHEMA_VERSION);
    expect(parsed.agents[0].pane).toBe('%42');
  });
});
