import { describe, expect, test } from 'bun:test';
import { runWait, parseWaitState } from './wait.ts';
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

describe('runWait', () => {
  test('reaches state → 0 as the session progresses across frames', async () => {
    const clock = fakeClock();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: scripted([
        [makeState({ status: AgentStatus.BUSY })],
        [makeState({ status: AgentStatus.BUSY })],
        [makeState({ status: AgentStatus.DONE })],
      ]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(code).toBe(0);
  });

  test('timeout → 124 when the target never appears', async () => {
    const clock = fakeClock();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: '1', // deadline at t=1000ms; POLL_MS=500 crosses it in a few polls
      getStates: scripted([[makeState({ status: AgentStatus.BUSY })]]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(code).toBe(124);
  });

  test('unknown --state → exit 1 with "Unknown state"', async () => {
    const cap = capture();
    const code = await runWait({
      session: 'test',
      stateArg: 'bogus',
      timeoutArg: undefined,
      getStates: () => [],
      sleep: async () => {},
      now: () => 0,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain('Unknown state');
  });

  test('non-waitable --state (shell) → exit 1 with "Unknown state"', async () => {
    const cap = capture();
    const code = await runWait({
      session: 'test',
      stateArg: 'shell',
      timeoutArg: undefined,
      getStates: () => [],
      sleep: async () => {},
      now: () => 0,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain('Unknown state');
  });

  test('unknown session at start → exit 1 with "No agents found"', async () => {
    const cap = capture();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: () => [makeState({ session: 'other' })],
      sleep: async () => {},
      now: () => 0,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain("No agents found in session 'test'");
  });

  test('already satisfied at start → 0 with zero sleep calls', async () => {
    const clock = fakeClock();
    let sleepCalls = 0;
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: scripted([[makeState({ status: AgentStatus.DONE })]]),
      sleep: async (ms) => {
        sleepCalls++;
        await clock.sleep(ms);
      },
      now: clock.now,
    });
    expect(code).toBe(0);
    expect(sleepCalls).toBe(0);
  });

  test('any-pane match: only the second pane in the session is at target → 0', async () => {
    const clock = fakeClock();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: scripted([
        [makeState({ paneId: '%1', status: AgentStatus.BUSY }), makeState({ paneId: '%2', status: AgentStatus.DONE })],
      ]),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(code).toBe(0);
  });

  test('session disappears mid-wait → exit 1 with "disappeared while waiting"', async () => {
    const cap = capture();
    const clock = fakeClock();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: scripted([[makeState({ status: AgentStatus.BUSY })], []]),
      sleep: clock.sleep,
      now: clock.now,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain("Session 'test' disappeared while waiting");
  });

  test('--timeout 0 → one check then 124 without sleeping', async () => {
    const clock = fakeClock();
    let sleepCalls = 0;
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: '0',
      getStates: scripted([[makeState({ status: AgentStatus.BUSY })]]),
      sleep: async (ms) => {
        sleepCalls++;
        await clock.sleep(ms);
      },
      now: clock.now,
    });
    expect(code).toBe(124);
    expect(sleepCalls).toBe(0);
  });

  test('invalid --timeout → exit 1 with "Invalid --timeout"', async () => {
    const cap = capture();
    const code = await runWait({
      session: 'test',
      stateArg: 'ready',
      timeoutArg: 'abc',
      getStates: () => [],
      sleep: async () => {},
      now: () => 0,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain('Invalid --timeout');
  });

  test('missing session → usage error, exit 1', async () => {
    const cap = capture();
    const code = await runWait({
      session: undefined,
      stateArg: 'ready',
      timeoutArg: undefined,
      getStates: () => [],
      sleep: async () => {},
      now: () => 0,
      stderr: cap.sink,
    });
    expect(code).toBe(1);
    expect(cap.text()).toContain('Usage: fleet wait');
  });
});
