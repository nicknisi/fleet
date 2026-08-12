import { describe, expect, test } from 'bun:test';
import { runWait, parseWaitState, parseWaitArgs } from './wait.ts';
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
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...overrides,
});

// Returns each scripted frame in turn; the last frame sticks so a "never
// reaches" script keeps returning the same non-matching state.
function scripted(frames: AgentState[][]) {
  let i = 0;
  return () => frames[Math.min(i++, frames.length - 1)]!;
}

// Deterministic clock: sleep advances virtual time instead of waiting, so a
// timeout crosses its deadline in a few polls without any real delay.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function capture() {
  const lines: string[] = [];
  return { sink: (s: string) => lines.push(s), text: () => lines.join('') };
}

// Base options every runWait test overrides — keeps each case to just the
// fields it exercises.
const base = (over: Partial<Parameters<typeof runWait>[0]>): Parameters<typeof runWait>[0] => ({
  selectors: ['test'],
  stateArgs: ['ready'],
  timeoutArg: undefined,
  any: false,
  getStates: () => [],
  tmuxOk: () => true,
  sleep: async () => {},
  now: () => 0,
  ...over,
});

describe('parseWaitState', () => {
  test('maps display labels to enums (case-insensitive, trimmed)', () => {
    expect(parseWaitState('ready')).toBe(AgentStatus.DONE);
    expect(parseWaitState('waiting')).toBe(AgentStatus.PERMIT);
    expect(parseWaitState('asking')).toBe(AgentStatus.QUESTION);
    expect(parseWaitState('working')).toBe(AgentStatus.BUSY);
    expect(parseWaitState('idle')).toBe(AgentStatus.IDLE);
    expect(parseWaitState('READY')).toBe(AgentStatus.DONE);
    expect(parseWaitState('  Working  ')).toBe(AgentStatus.BUSY);
  });

  test('maps raw enum names to enums (case-insensitive)', () => {
    expect(parseWaitState('DONE')).toBe(AgentStatus.DONE);
    expect(parseWaitState('done')).toBe(AgentStatus.DONE);
    expect(parseWaitState('PERMIT')).toBe(AgentStatus.PERMIT);
    expect(parseWaitState('QUESTION')).toBe(AgentStatus.QUESTION);
    expect(parseWaitState('BUSY')).toBe(AgentStatus.BUSY);
    expect(parseWaitState('IDLE')).toBe(AgentStatus.IDLE);
  });

  test('rejects unknown, non-waitable, and empty inputs', () => {
    expect(parseWaitState('bogus')).toBeNull();
    expect(parseWaitState('shell')).toBeNull();
    expect(parseWaitState('down')).toBeNull();
    expect(parseWaitState('')).toBeNull();
  });
});

describe('parseWaitArgs', () => {
  test('collects positional selectors, a single --state, and defaults', () => {
    const p = parseWaitArgs(['api', '--state', 'ready']);
    expect(p.selectors).toEqual(['api']);
    expect(p.stateArgs).toEqual(['ready']);
    expect(p.timeoutArg).toBeUndefined();
    expect(p.any).toBe(false);
  });

  test('collects multiple selectors and multiple --state values in order', () => {
    const p = parseWaitArgs(['%1', '@2', 'api:build', '--state', 'ready', '--state', 'waiting']);
    expect(p.selectors).toEqual(['%1', '@2', 'api:build']);
    expect(p.stateArgs).toEqual(['ready', 'waiting']);
  });

  test('parses --any and --timeout', () => {
    const p = parseWaitArgs(['api', '--state', 'ready', '--any', '--timeout', '30']);
    expect(p.any).toBe(true);
    expect(p.timeoutArg).toBe('30');
  });

  test('order-independent: flags before positionals still parse', () => {
    const p = parseWaitArgs(['--any', '--state', 'busy', '--timeout', '5', 'api', 'db']);
    expect(p.selectors).toEqual(['api', 'db']);
    expect(p.stateArgs).toEqual(['busy']);
    expect(p.any).toBe(true);
    expect(p.timeoutArg).toBe('5');
  });

  test('empty argv yields empty selectors/states and defaults', () => {
    const p = parseWaitArgs([]);
    expect(p.selectors).toEqual([]);
    expect(p.stateArgs).toEqual([]);
    expect(p.any).toBe(false);
    expect(p.timeoutArg).toBeUndefined();
  });
});

describe('runWait — single session (original behavior preserved)', () => {
  test('reaches state → 0 as the session progresses across frames', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        selectors: ['test'],
        stateArgs: ['ready'],
        getStates: scripted([
          [makeState({ status: AgentStatus.BUSY })],
          [makeState({ status: AgentStatus.BUSY })],
          [makeState({ status: AgentStatus.DONE })],
        ]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(0);
  });

  test('timeout → 124 when the target never appears', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        timeoutArg: '1', // deadline at t=1000ms; POLL_MS=500 crosses it in a few polls
        getStates: scripted([[makeState({ status: AgentStatus.BUSY })]]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(124);
  });

  test('unknown --state → exit 1 with "Unknown state"', async () => {
    const cap = capture();
    const code = await runWait(base({ stateArgs: ['bogus'], stderr: cap.sink }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('Unknown state');
  });

  test('non-waitable --state (shell) → exit 1 with "Unknown state"', async () => {
    const cap = capture();
    const code = await runWait(base({ stateArgs: ['shell'], stderr: cap.sink }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('Unknown state');
  });

  test('unknown session at start → exit 2 with "No agents found matching session"', async () => {
    const cap = capture();
    const code = await runWait(base({ getStates: () => [makeState({ session: 'other' })], stderr: cap.sink }));
    expect(code).toBe(2);
    expect(cap.text()).toContain("No agents found matching session 'test'");
  });

  test('already satisfied at start → 0 with zero sleep calls', async () => {
    const clock = fakeClock();
    let sleepCalls = 0;
    const code = await runWait(
      base({
        getStates: scripted([[makeState({ status: AgentStatus.DONE })]]),
        sleep: async (ms) => {
          sleepCalls++;
          await clock.sleep(ms);
        },
        now: clock.now,
      }),
    );
    expect(code).toBe(0);
    expect(sleepCalls).toBe(0);
  });

  test('any-pane match: only the second pane in the session is at target → 0', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        getStates: scripted([
          [
            makeState({ paneId: '%1', status: AgentStatus.BUSY }),
            makeState({ paneId: '%2', status: AgentStatus.DONE }),
          ],
        ]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(0);
  });

  test('session disappears mid-wait → exit 2 with "disappeared while waiting"', async () => {
    const cap = capture();
    const clock = fakeClock();
    const code = await runWait(
      base({
        getStates: scripted([[makeState({ status: AgentStatus.BUSY })], []]),
        sleep: clock.sleep,
        now: clock.now,
        stderr: cap.sink,
      }),
    );
    expect(code).toBe(2);
    expect(cap.text()).toContain("session 'test' disappeared while waiting");
  });

  test('a transient tmux failure is Unknown and does not report disappearance', async () => {
    const cap = capture();
    const clock = fakeClock();
    let poll = 0;
    const code = await runWait(
      base({
        getStates: () => {
          poll++;
          return poll === 1 ? [] : [makeState({ status: AgentStatus.DONE })];
        },
        tmuxOk: () => poll > 1,
        sleep: clock.sleep,
        now: clock.now,
        stderr: cap.sink,
      }),
    );
    expect(code).toBe(0);
    expect(cap.text()).toBe('');
  });

  test('--timeout 0 → one check then 124 without sleeping', async () => {
    const clock = fakeClock();
    let sleepCalls = 0;
    const code = await runWait(
      base({
        timeoutArg: '0',
        getStates: scripted([[makeState({ status: AgentStatus.BUSY })]]),
        sleep: async (ms) => {
          sleepCalls++;
          await clock.sleep(ms);
        },
        now: clock.now,
      }),
    );
    expect(code).toBe(124);
    expect(sleepCalls).toBe(0);
  });

  test('invalid --timeout → exit 1 with "Invalid --timeout"', async () => {
    const cap = capture();
    const code = await runWait(base({ timeoutArg: 'abc', stderr: cap.sink }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('Invalid --timeout');
  });

  test('missing selectors → usage error, exit 1', async () => {
    const cap = capture();
    const code = await runWait(base({ selectors: [], stderr: cap.sink }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('Usage: fleet wait');
  });

  test('missing --state → usage error, exit 1', async () => {
    const cap = capture();
    const code = await runWait(base({ stateArgs: [], stderr: cap.sink }));
    expect(code).toBe(1);
    expect(cap.text()).toContain('Usage: fleet wait');
  });
});

describe('runWait — multiple states (any state satisfies)', () => {
  test('reaches EITHER of two target states → 0', async () => {
    const code = await runWait(
      base({
        stateArgs: ['ready', 'waiting'],
        getStates: scripted([[makeState({ status: AgentStatus.PERMIT })]]),
      }),
    );
    expect(code).toBe(0);
  });

  test('a state outside the target set keeps waiting until timeout', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        stateArgs: ['ready', 'waiting'],
        timeoutArg: '1',
        getStates: scripted([[makeState({ status: AgentStatus.BUSY })]]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(124);
  });
});

describe('runWait — multiple selectors', () => {
  const twoSessions = (aStatus: AgentStatus, bStatus: AgentStatus) => [
    makeState({ paneId: '%1', session: 'api' }),
    makeState({ paneId: '%2', session: 'api', status: aStatus }),
    makeState({ paneId: '%3', session: 'db', status: bStatus }),
  ];

  test('default (ALL): waits until every selector is satisfied', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        selectors: ['api', 'db'],
        stateArgs: ['ready'],
        getStates: scripted([
          twoSessions(AgentStatus.BUSY, AgentStatus.DONE), // db ready, api not
          twoSessions(AgentStatus.DONE, AgentStatus.DONE), // both ready
        ]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(0);
  });

  test('default (ALL): one selector never reaching → timeout 124', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        selectors: ['api', 'db'],
        stateArgs: ['ready'],
        timeoutArg: '1',
        getStates: scripted([twoSessions(AgentStatus.BUSY, AgentStatus.DONE)]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(124);
  });

  test('--any: succeeds as soon as ONE selector is satisfied', async () => {
    const code = await runWait(
      base({
        selectors: ['api', 'db'],
        stateArgs: ['ready'],
        any: true,
        getStates: scripted([twoSessions(AgentStatus.BUSY, AgentStatus.DONE)]), // only db ready
      }),
    );
    expect(code).toBe(0);
  });

  test('--any ignores a selector that never exists while another can satisfy', async () => {
    const clock = fakeClock();
    const code = await runWait(
      base({
        selectors: ['missing', 'db'],
        stateArgs: ['ready'],
        any: true,
        getStates: scripted([
          [makeState({ paneId: '%3', session: 'db', status: AgentStatus.BUSY })],
          [makeState({ paneId: '%3', session: 'db', status: AgentStatus.DONE })],
        ]),
        sleep: clock.sleep,
        now: clock.now,
      }),
    );
    expect(code).toBe(0);
  });

  test('--any returns no-match only when every selector is absent', async () => {
    const code = await runWait(
      base({
        selectors: ['missing-a', 'missing-b'],
        stateArgs: ['ready'],
        any: true,
        getStates: () => [],
      }),
    );
    expect(code).toBe(2);
  });

  test('mixed selector kinds (pane + session:window) resolve independently', async () => {
    const code = await runWait(
      base({
        selectors: ['%2', 'db:main'],
        stateArgs: ['ready'],
        getStates: scripted([twoSessions(AgentStatus.DONE, AgentStatus.DONE)]),
      }),
    );
    expect(code).toBe(0);
  });
});

describe('runWait — disappearance', () => {
  test('a pane selector that vanishes after matching → exit 2', async () => {
    const cap = capture();
    const clock = fakeClock();
    const code = await runWait(
      base({
        selectors: ['%42'],
        stateArgs: ['ready'],
        getStates: scripted([[makeState({ paneId: '%42', status: AgentStatus.BUSY })], []]),
        sleep: clock.sleep,
        now: clock.now,
        stderr: cap.sink,
      }),
    );
    expect(code).toBe(2);
    expect(cap.text()).toContain("pane '%42' disappeared while waiting");
  });
});
