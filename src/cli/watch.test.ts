import { describe, expect, test } from 'bun:test';
import { selectAgents, diffStates, snapshotLine, runWatch, type ChangeLine } from './watch.ts';
import { SCHEMA_VERSION } from './schema.ts';
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

describe('selectAgents', () => {
  const world = [
    makeState({ paneId: '%1', session: 'api', window: 'main' }),
    makeState({ paneId: '%2', session: 'api', window: 'build' }),
    makeState({ paneId: '%3', session: 'db', window: 'main' }),
    makeState({ paneId: '%4', agentType: '', status: AgentStatus.SHELL }),
  ];

  test('no selectors → every agent (shell dropped)', () => {
    expect(selectAgents(world, []).map((a) => a.paneId)).toEqual(['%1', '%2', '%3']);
  });

  test('a selector narrows to its matches', () => {
    expect(selectAgents(world, ['api']).map((a) => a.paneId)).toEqual(['%1', '%2']);
  });

  test('multiple selectors union without duplicating a shared pane', () => {
    // 'api' and '%1' both include %1 — it appears once.
    expect(selectAgents(world, ['api', '%1']).map((a) => a.paneId)).toEqual(['%1', '%2']);
  });
});

describe('diffStates', () => {
  test('an initial empty map reports every agent as an appearance (from: null)', () => {
    const { changes, next } = diffStates(new Map(), [makeState({ paneId: '%1', status: AgentStatus.BUSY })], 10);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBeNull();
    expect(changes[0]!.to).toBe(AgentStatus.BUSY);
    expect(next.get('%1')).toBe(AgentStatus.BUSY);
  });

  test('an unchanged status emits nothing', () => {
    const prev = new Map<string, string>([['%1', AgentStatus.BUSY]]);
    const { changes } = diffStates(prev, [makeState({ paneId: '%1', status: AgentStatus.BUSY })], 10);
    expect(changes).toHaveLength(0);
  });

  test('a status change emits one line with from/to and the full agent view', () => {
    const prev = new Map<string, string>([['%1', AgentStatus.BUSY]]);
    const { changes } = diffStates(prev, [makeState({ paneId: '%1', status: AgentStatus.DONE })], 20);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBe(AgentStatus.BUSY);
    expect(changes[0]!.to).toBe(AgentStatus.DONE);
    expect(changes[0]!.agent?.pane).toBe('%1');
    expect(changes[0]!.type).toBe('change');
    expect(changes[0]!.schema).toBe(SCHEMA_VERSION);
  });

  test('a filtered change keeps sibling count from the unfiltered roster', () => {
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
    const selected = makeState({ paneId: '%1', status: AgentStatus.DONE, git: git('/repo') });
    const sibling = makeState({ paneId: '%2', git: git('/repo-wt') });
    const { changes } = diffStates(new Map([['%1', AgentStatus.BUSY]]), [selected], 20, [selected, sibling]);
    expect(changes[0]!.agent?.repoSiblingCount).toBe(1);
  });

  test('a disappearance emits to: null with a null agent view', () => {
    const prev = new Map<string, string>([['%1', AgentStatus.BUSY]]);
    const { changes, next } = diffStates(prev, [], 30);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBe(AgentStatus.BUSY);
    expect(changes[0]!.to).toBeNull();
    expect(changes[0]!.agent).toBeNull();
    expect(next.size).toBe(0);
  });
});

describe('snapshotLine', () => {
  test('is the versioned envelope tagged type:"snapshot"', () => {
    const line = JSON.parse(snapshotLine([makeState({})], [], true, 100));
    expect(line.schema).toBe(SCHEMA_VERSION);
    expect(line.type).toBe('snapshot');
    expect(line.outcome).toBe('ok');
    expect(line.count).toBe(1);
    expect(line.selector).toBeNull();
  });

  test('joins selectors into the envelope selector field', () => {
    const line = JSON.parse(snapshotLine([], ['api', 'db'], true, 1));
    expect(line.selector).toBe('api,db');
    expect(line.outcome).toBe('no_match'); // selector applied, nothing matched
  });
});

describe('runWatch', () => {
  // Emit N states across ticks, then stop. Drives the whole loop synchronously
  // via a fake clock so no real timers fire.
  async function drive(frames: AgentState[][], selectors: string[] = []) {
    const emitted: string[] = [];
    let tick = 0;
    // Stop after all frames are consumed (loop reads frame per tick).
    await runWatch({
      selectors,
      getStates: () => frames[Math.min(tick, frames.length - 1)]!,
      tmuxOk: () => true,
      emit: (l) => emitted.push(l),
      sleep: async () => {
        tick++;
      },
      now: () => tick,
      stop: () => tick >= frames.length,
      intervalMs: 1,
    });
    return emitted.map((l) => JSON.parse(l));
  }

  test('emits an initial snapshot line first', async () => {
    const lines = await drive([[makeState({ status: AgentStatus.BUSY })]]);
    expect(lines[0].type).toBe('snapshot');
  });

  test('emits a change line when a pane transitions', async () => {
    const lines = await drive([
      [makeState({ paneId: '%1', status: AgentStatus.BUSY })],
      [makeState({ paneId: '%1', status: AgentStatus.DONE })],
    ]);
    expect(lines[0].type).toBe('snapshot');
    const change = lines.find((l) => l.type === 'change');
    expect(change.from).toBe(AgentStatus.BUSY);
    expect(change.to).toBe(AgentStatus.DONE);
  });

  test('emits a disappearance change when a pane vanishes', async () => {
    const lines = await drive([[makeState({ paneId: '%1', status: AgentStatus.BUSY })], []]);
    // SAFETY: the find predicate above selects l.type === 'change', which is exactly ChangeLine.
    const change = lines.find((l) => l.type === 'change') as ChangeLine;
    expect(change.to).toBeNull();
    expect(change.pane).toBe('%1');
  });

  test('a stopped watch emits only the snapshot (no change ticks)', async () => {
    const emitted: string[] = [];
    await runWatch({
      selectors: [],
      getStates: () => [makeState({ status: AgentStatus.BUSY })],
      tmuxOk: () => true,
      emit: (l) => emitted.push(l),
      sleep: async () => {},
      now: () => 0,
      stop: () => true, // already stopped: the while loop never runs
      intervalMs: 1,
    });
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!).type).toBe('snapshot');
  });

  test('a transient tmux failure emits one degraded snapshot, not disappearance churn', async () => {
    const emitted: string[] = [];
    const frames = [
      [makeState({ paneId: '%1', status: AgentStatus.BUSY })],
      [makeState({ paneId: '%1', status: AgentStatus.BUSY })],
      [makeState({ paneId: '%1', status: AgentStatus.DONE })],
    ];
    const availability = [true, false, true];
    let tick = 0;
    await runWatch({
      selectors: [],
      getStates: () => frames[Math.min(tick, frames.length - 1)]!,
      tmuxOk: () => availability[Math.min(tick, availability.length - 1)]!,
      emit: (line) => emitted.push(line),
      sleep: async () => {
        tick++;
      },
      now: () => tick,
      stop: () => tick >= 3,
      intervalMs: 1,
    });
    const lines = emitted.map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['snapshot', 'snapshot', 'snapshot']);
    expect(lines[1].outcome).toBe('stale_data');
    expect(lines.some((line) => line.type === 'change' && line.to === null)).toBe(false);
  });

  test('respects selectors: a change on an unselected pane is not emitted', async () => {
    const lines = await drive(
      [
        [
          makeState({ paneId: '%1', session: 'api', status: AgentStatus.BUSY }),
          makeState({ paneId: '%2', session: 'db', status: AgentStatus.BUSY }),
        ],
        [
          makeState({ paneId: '%1', session: 'api', status: AgentStatus.BUSY }),
          makeState({ paneId: '%2', session: 'db', status: AgentStatus.DONE }),
        ],
      ],
      ['api'],
    );
    // Only %1 is watched; %2's BUSY→DONE must not appear.
    expect(lines.some((l) => l.type === 'change')).toBe(false);
  });
});
