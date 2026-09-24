import { describe, expect, test } from 'bun:test';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { TuiApp, TuiMode } from './app.ts';
import {
  handleAnswerInput,
  handleKillConfirmInput,
  handlePassthroughInput,
  handleSendInput,
  type ActionIO,
} from './actions.ts';

// The bottom of a real Claude Code 2.1.280 pane showing an AskUserQuestion form.
const questionForm = [
  '❯ Ask the fixture questions.',
  '←  ☐ Colour  ☐ Note  ✔ Submit  →',
  'Which fixture colour should Fleet select?',
  '❯ 1. Red',
  '  2. Blue',
  '  3. Type something.',
  '─'.repeat(40),
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];
const answeredPrompt = ['● User answered Claude’s questions:', '─'.repeat(40), '❯ ', '─'.repeat(40)];

const state = (paneId: string, status: AgentState['status'] = AgentStatus.IDLE): AgentState => ({
  paneId,
  paneNum: Number(paneId.slice(1)),
  panePid: 100,
  session: paneId,
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status,
  tool: null,
  project: null,
  branch: null,
  ports: [],
  ts: 0,
  agentType: 'claude',
});
function setup() {
  const a = state('%1');
  const b = state('%2');
  const app = new TuiApp();
  app.updateStates([a, b]);
  const calls: string[] = [];
  const io: ActionIO = {
    readState: (target) => target,
    send: (pane, text) => {
      calls.push(`send ${pane} ${text}`);
    },
    kill: (pane) => {
      calls.push(`kill ${pane}`);
    },
    forward: (pane, data) => {
      calls.push(`raw ${pane} ${data}`);
    },
    capture: () => questionForm,
  };
  return { a, b, app, io, calls };
}

describe('pinned action dispatch', () => {
  test('x never confirms deletion; y revalidates the original target', () => {
    const { app, io, calls } = setup();
    app.enterKillConfirm();
    handleKillConfirmInput(app, { type: 'char', char: 'x' }, io);
    expect(calls).toEqual([]);
    app.enterKillConfirm();
    app.moveDown();
    handleKillConfirmInput(app, { type: 'char', char: 'y' }, io);
    expect(calls).toEqual(['kill %1']);
  });
  test('a killed or newly busy target cannot be confirmed using cached eligibility', () => {
    for (const missing of [false, true]) {
      const { app, io, a, calls } = setup();
      app.enterKillConfirm();
      io.readState = () => {
        if (missing) throw new Error('gone');
        return { ...a, status: AgentStatus.BUSY };
      };
      handleKillConfirmInput(app, { type: 'char', char: 'y' }, io);
      expect(calls).toEqual([]);
      expect(app.mode).toBe(TuiMode.DASHBOARD);
      expect(app.actionError).not.toBeNull();
    }
  });
  test('send stays on the original pane after selection changes', () => {
    const { app, io, calls } = setup();
    app.enterSend();
    app.sendBuffer = 'hello';
    app.moveDown();
    handleSendInput(app, { type: 'enter' }, io);
    expect(calls).toEqual(['send %1 hello']);
    expect(app.mode).toBe(TuiMode.DASHBOARD);
  });
  test('a fresh question rejects the send and retains its draft', () => {
    const { app, io, a, calls } = setup();
    app.enterSend();
    app.sendBuffer = 'keep this';
    io.readState = () => ({ ...a, status: AgentStatus.QUESTION });
    handleSendInput(app, { type: 'enter' }, io);
    expect(calls).toEqual([]);
    expect(app.sendBuffer).toBe('keep this');
    expect(app.mode).toBe(TuiMode.SEND);
    expect(app.actionError).toContain('question');
  });
  test('transport failure never clears a draft or retries it', () => {
    const { app, io } = setup();
    app.enterSend();
    app.sendBuffer = 'keep this';
    let attempts = 0;
    io.send = () => {
      attempts++;
      throw new Error('transport failed');
    };
    handleSendInput(app, { type: 'enter' }, io);
    expect(attempts).toBe(1);
    expect(app.sendBuffer).toBe('keep this');
    expect(app.actionError).toContain('inspect target');
  });
  test('a vanished send target retains its label and draft, never substituting the next row', () => {
    const { app, io, b, calls } = setup();
    app.enterSend();
    app.sendBuffer = 'private draft';
    app.updateStates([b]);
    io.readState = () => {
      throw new Error('gone');
    };
    handleSendInput(app, { type: 'enter' }, io);
    expect(app.actionTarget?.paneId).toBe('%1');
    expect(app.selectedState()?.paneId).toBe('%2');
    expect(app.sendBuffer).toBe('private draft');
    expect(calls).toEqual([]);
  });
  test('passthrough never follows browsing selection', () => {
    const { app, io, calls } = setup();
    app.enterPassthrough();
    app.moveDown();
    handlePassthroughInput(app, Buffer.from('hello'), io);
    expect(calls).toEqual(['raw %1 hello']);
  });
  test('pane respawn cancels passthrough even when the pane id survives', () => {
    const { app, io, a, b, calls } = setup();
    app.enterPassthrough();
    app.updateStates([{ ...a, panePid: 200 }, b]);
    handlePassthroughInput(app, Buffer.from('private input'), io);
    expect(calls).toEqual([]);
    expect(app.mode).toBe(TuiMode.PREVIEW);
  });
  test('failed forwarding exits passthrough', () => {
    const { app, io } = setup();
    app.enterPassthrough();
    io.forward = () => {
      throw new Error('target gone');
    };
    handlePassthroughInput(app, Buffer.from('a'), io);
    expect(app.mode).toBe(TuiMode.PREVIEW);
    expect(app.actionError).toBe('target gone');
  });
});

describe('answering a native question in place', () => {
  test('forwards to the pinned target only while its form is open, then returns', () => {
    const { app, io, calls } = setup();
    app.mode = TuiMode.PREVIEW;
    app.enterAnswer();
    app.moveDown();
    handleAnswerInput(app, Buffer.from('\x1b[B'), io);
    expect(calls).toEqual(['raw %1 \x1b[B']);
    // After submission the pane is back at its prompt: typing must not reach it.
    io.capture = () => answeredPrompt;
    handleAnswerInput(app, Buffer.from('yes\r'), io);
    expect(calls).toHaveLength(1);
    expect(app.mode).toBe(TuiMode.PREVIEW);
    expect(app.actionTarget).toBeNull();
  });
  test('Escape and an embedded interrupt leave without reaching the question', () => {
    // A coalesced read can carry Escape before or after other keys.
    for (const key of ['\x1b', 'a\x03', '\x1bj', '1\x1b', '\x1b[B\x1b']) {
      const { app, io, calls } = setup();
      app.enterAnswer();
      handleAnswerInput(app, Buffer.from(key), io);
      expect(calls).toEqual([]);
      expect(app.mode).toBe(TuiMode.DASHBOARD);
    }
  });
  test('a respawned, unreadable or failing target stops answering without forwarding', () => {
    const respawned = setup();
    respawned.app.enterAnswer();
    respawned.app.updateStates([{ ...respawned.a, panePid: 200 }, respawned.b]);
    handleAnswerInput(respawned.app, Buffer.from('1'), respawned.io);
    expect(respawned.calls).toEqual([]);
    expect(respawned.app.mode).toBe(TuiMode.DASHBOARD);
    for (const failing of ['capture', 'forward'] as const) {
      const { app, io, calls } = setup();
      app.enterAnswer();
      io[failing] = () => {
        throw new Error(`${failing} failed`);
      };
      handleAnswerInput(app, Buffer.from('1'), io);
      expect(calls).toEqual([]);
      expect(app.mode).toBe(TuiMode.DASHBOARD);
      expect(app.actionError).toBe(`${failing} failed`);
    }
  });
});
