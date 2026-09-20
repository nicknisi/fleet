import { describe, expect, test } from 'bun:test';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { TuiApp, TuiMode } from './app.ts';
import { handleKillConfirmInput, handlePassthroughInput, handleSendInput, type ActionIO } from './actions.ts';

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
