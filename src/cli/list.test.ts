import { describe, expect, test } from 'bun:test';
import { runList } from './list.ts';
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

describe('runList — human', () => {
  test('renders one line per agent, most-urgent first', () => {
    const { stdout, code } = runList(
      [],
      [
        makeState({ paneId: '%1', status: AgentStatus.IDLE, session: 'idle-s' }),
        makeState({ paneId: '%2', status: AgentStatus.PERMIT, session: 'permit-s' }),
      ],
      true,
      1000,
    );
    expect(code).toBe(EXIT.OK);
    const lines = stdout.split('\n');
    expect(lines).toHaveLength(2);
    // PERMIT sorts above IDLE.
    expect(lines[0]).toContain('waiting');
    expect(lines[1]).toContain('idle');
  });

  test('drops shell panes from the roster', () => {
    const { stdout } = runList(
      [],
      [makeState({ agentType: '', status: AgentStatus.SHELL }), makeState({ paneId: '%2', agentType: 'claude' })],
      true,
      1000,
    );
    expect(stdout.split('\n')).toHaveLength(1); // only the real agent
    expect(stdout).toContain('%2');
  });

  test('empty world prints a friendly line and exits 0', () => {
    const { stdout, code } = runList([], [], true, 1000);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe('No agents found');
  });

  test('tmux unavailable prints "tmux unavailable" but still exits 0 on the human path', () => {
    const { stdout, code } = runList([], [], false, 1000);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe('tmux unavailable');
  });
});

describe('runList — JSON', () => {
  test('emits the versioned envelope, ok outcome, agents only', () => {
    const { stdout, code } = runList(
      ['--json'],
      [makeState({ paneId: '%1', agentType: 'claude' }), makeState({ paneId: '%2', agentType: '' })],
      true,
      2000,
    );
    const env = parse(stdout);
    expect(env.schema).toBe(SCHEMA_VERSION);
    expect(env.outcome).toBe('ok');
    expect(env.queriedAt).toBe(2000);
    expect(env.count).toBe(1); // shell pane dropped
    expect(env.agents[0]!.pane).toBe('%1');
    expect(code).toBe(EXIT.OK);
  });

  test('no agents → no_agents outcome, exit 0', () => {
    const { stdout, code } = runList(['--json'], [], true, 1);
    expect(parse(stdout).outcome).toBe('no_agents');
    expect(code).toBe(EXIT.OK);
  });

  test('tmux down with no cache → tmux_unavailable, exit 4', () => {
    const { stdout, code } = runList(['--json'], [], false, 1);
    expect(parse(stdout).outcome).toBe('tmux_unavailable');
    expect(code).toBe(EXIT.TMUX_UNAVAILABLE);
  });

  test('tmux down with cached agents → stale_data, exit 0', () => {
    const { stdout, code } = runList(['--json'], [makeState({})], false, 1);
    expect(parse(stdout).outcome).toBe('stale_data');
    expect(code).toBe(EXIT.OK);
  });

  test('list never applies a selector (selector is always null)', () => {
    const { stdout } = runList(['--json'], [makeState({})], true, 1);
    expect(parse(stdout).selector).toBeNull();
  });
});
