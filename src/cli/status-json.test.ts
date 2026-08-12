import { describe, expect, test } from 'bun:test';
import { runStatusJson } from './status.ts';
import { SCHEMA_VERSION, type Envelope } from './schema.ts';
import { EXIT } from './exit-codes.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

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

const parse = (s: string): Envelope => JSON.parse(s);

const world: AgentState[] = [
  makeState({ paneId: '%1', windowId: '@1', session: 'api', window: 'main', status: AgentStatus.PERMIT }),
  makeState({ paneId: '%2', windowId: '@2', session: 'api', window: 'build', status: AgentStatus.BUSY }),
  makeState({ paneId: '%3', windowId: '@3', session: 'db', window: 'main', status: AgentStatus.DONE }),
  makeState({ paneId: '%4', windowId: '@4', session: 'shell', window: 'x', agentType: '', status: AgentStatus.SHELL }),
];

describe('runStatusJson — no selector', () => {
  test('reports every agent (shell dropped), ok outcome, null selector', () => {
    const { stdout, code } = runStatusJson([], world, true, 5000);
    const env = parse(stdout);
    expect(env.schema).toBe(SCHEMA_VERSION);
    expect(env.outcome).toBe('ok');
    expect(env.selector).toBeNull();
    expect(env.count).toBe(3);
    expect(code).toBe(EXIT.OK);
  });

  test('empty world → no_agents, exit 0', () => {
    const { stdout, code } = runStatusJson([], [], true, 1);
    expect(parse(stdout).outcome).toBe('no_agents');
    expect(code).toBe(EXIT.OK);
  });
});

describe('runStatusJson — selector', () => {
  test('bare session narrows to that session', () => {
    const { stdout, code } = runStatusJson(['api'], world, true, 1);
    const env = parse(stdout);
    expect(env.selector).toBe('api');
    expect(env.count).toBe(2);
    expect(env.agents.map((a) => a.pane).sort()).toEqual(['%1', '%2']);
    expect(env.outcome).toBe('ok');
    expect(code).toBe(EXIT.OK);
  });

  test('pane id narrows to one agent', () => {
    const env = parse(runStatusJson(['%3'], world, true, 1).stdout);
    expect(env.count).toBe(1);
    expect(env.agents[0]!.session).toBe('db');
  });

  test('pane selector keeps sibling count from the unfiltered roster', () => {
    const git = (worktreeRoot: string) => ({
      repoId: '/repo/.git',
      commonDir: '/repo/.git',
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
    const siblings = [
      makeState({ paneId: '%10', git: git('/repo') }),
      makeState({ paneId: '%11', git: git('/repo-wt') }),
    ];
    const env = parse(runStatusJson(['%10'], siblings, true, 1).stdout);
    expect(env.agents[0]!.repoSiblingCount).toBe(1);
  });

  test('session:window narrows on both components', () => {
    const env = parse(runStatusJson(['api:build'], world, true, 1).stdout);
    expect(env.count).toBe(1);
    expect(env.agents[0]!.pane).toBe('%2');
  });

  test('a selector matching nothing → no_match, exit 2', () => {
    const { stdout, code } = runStatusJson(['nope'], world, true, 1);
    expect(parse(stdout).outcome).toBe('no_match');
    expect(code).toBe(EXIT.NO_MATCH);
  });

  test('a selector resolving only to a shell pane → no_match (shell is not an agent)', () => {
    const { stdout, code } = runStatusJson(['shell'], world, true, 1);
    expect(parse(stdout).outcome).toBe('no_match');
    expect(code).toBe(EXIT.NO_MATCH);
  });

  test('flags are ignored when picking the selector positional', () => {
    const env = parse(runStatusJson(['--json', 'db'], world, true, 1).stdout);
    expect(env.selector).toBe('db');
    expect(env.count).toBe(1);
  });
});

describe('runStatusJson — tmux outcomes', () => {
  test('tmux down, no cache → tmux_unavailable, exit 4', () => {
    const { stdout, code } = runStatusJson([], [], false, 1);
    expect(parse(stdout).outcome).toBe('tmux_unavailable');
    expect(code).toBe(EXIT.TMUX_UNAVAILABLE);
  });

  test('tmux down with cached agents → stale_data, exit 0', () => {
    const { stdout, code } = runStatusJson([], world, false, 1);
    expect(parse(stdout).outcome).toBe('stale_data');
    expect(code).toBe(EXIT.OK);
  });
});
