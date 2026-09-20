import type { AgentState } from '../state/types.ts';
import type { KeyEvent } from '../terminal/input.ts';
import { type TuiApp } from './app.ts';
import { canSendTo } from './send.ts';
import { canKillSession } from './kill.ts';

export interface ActionIO {
  readState: (target: AgentState) => AgentState;
  send: (pane: string, text: string) => void;
  kill: (pane: string) => void;
  forward: (pane: string, data: Buffer, expectedPid?: number) => void;
}

export function handleSendInput(app: TuiApp, key: KeyEvent, io: Pick<ActionIO, 'readState' | 'send'>): void {
  switch (key.type) {
    case 'escape':
      app.exitSend();
      break;
    case 'backspace':
      app.sendBuffer = app.sendBuffer.slice(0, -1);
      break;
    case 'char':
      app.sendBuffer += key.char;
      break;
    case 'enter': {
      if (!app.sendBuffer.length) return;
      try {
        if (!app.actionTarget) throw new Error('No send target');
        const state = io.readState(app.actionTarget);
        const check = canSendTo(state);
        if (!check.ok) throw new Error(check.reason);
        io.send(app.actionTarget.paneId, app.sendBuffer);
        app.exitSend();
      } catch (error) {
        // Transport can fail after partial delivery. Retain text but never retry
        // automatically; the user must inspect the target before resubmitting.
        app.actionError = `${error instanceof Error ? error.message : 'Send failed'}. Draft kept; inspect target before retry.`;
      }
      break;
    }
  }
}

export function handleKillConfirmInput(app: TuiApp, key: KeyEvent, io: Pick<ActionIO, 'readState' | 'kill'>): void {
  if (key.type === 'char' && key.char === 'y') {
    try {
      if (!app.actionTarget) throw new Error('No kill target');
      const state = io.readState(app.actionTarget);
      const check = canKillSession(state);
      if (!check.ok) throw new Error(check.reason);
      io.kill(app.actionTarget.paneId);
    } catch (error) {
      app.actionError = error instanceof Error ? error.message : 'Kill failed';
    }
  }
  // x is an opener, never a confirmation. Every non-y key cancels.
  app.exitKillConfirm();
}

export function handlePassthroughInput(app: TuiApp, data: Buffer, io: Pick<ActionIO, 'forward'>): void {
  if (data.length === 1 && data[0] === 0x1b) {
    app.exitPassthrough();
    return;
  }
  const target = app.actionState();
  if (!target) {
    app.exitPassthrough();
    app.actionError = 'Passthrough target disappeared or changed';
    return;
  }
  try {
    io.forward(target.paneId, data, target.panePid);
  } catch (error) {
    app.exitPassthrough();
    app.actionError = error instanceof Error ? error.message : 'Forwarding failed';
  }
}
