import { expect, test } from 'bun:test';
import { dispatchInputBatch } from './input-batch.ts';
import { parseMouseEvent } from '../terminal/mouse.ts';

const batch = Buffer.from('\x1b[<0;30;10M\x1b[<32;90;10M\x1b[<0;90;10m');
type InputState = Parameters<typeof dispatchInputBatch>[0];
function state(): InputState {
  return { shouldQuit: false, actionError: null, actionTarget: null };
}

test('one Buffer dispatches press, movement and release in order', () => {
  const app = state();
  const events: string[] = [];
  let dragging = false;
  let position = 30;
  dispatchInputBatch(app, batch, (report) => {
    const event = parseMouseEvent(report)!;
    events.push(event.type);
    if (event.type === 'press') dragging = true;
    if (event.type === 'move' && dragging) position = event.x;
    if (event.type === 'release') dragging = false;
  });
  expect(events).toEqual(['press', 'move', 'release']);
  expect(position).toBe(90);
  expect(dragging).toBe(false);
});

test('an error dismisses the entire Buffer without dispatching later presses', () => {
  const app = state();
  app.actionError = 'target disappeared';
  const calls: Buffer[] = [];
  expect(dispatchInputBatch(app, batch, (report) => calls.push(report))).toBe(true);
  expect(app.actionError).toBeNull();
  expect(calls).toEqual([]);
});

test('Ctrl-C bypasses error dismissal and dispatch', () => {
  const app = state();
  app.actionError = 'target disappeared';
  dispatchInputBatch(app, Buffer.from('\x03'), () => {
    throw new Error('unexpected dispatch');
  });
  expect(app.shouldQuit).toBe(true);
  expect(app.actionError).toBe('target disappeared');
});

test.each([false, true])('a target-bearing error continues dispatch (initial error: %j)', (initial) => {
  const app = state();
  const target = {};
  app.actionTarget = target;
  if (initial) app.actionError = 'retry this action';
  const calls: Buffer[] = [];
  dispatchInputBatch(app, batch, (report) => {
    calls.push(report);
    app.actionError = 'retry this action';
  });
  expect(calls).toHaveLength(3);
  expect(app.actionError).toBe('retry this action');
  expect(app.actionTarget).toBe(target);
});

test.each(['finished', 'quit', 'error'])('a %s transition stops the remaining reports', (reason) => {
  const app = state();
  let calls = 0;
  let finished = false;
  dispatchInputBatch(
    app,
    batch,
    () => {
      calls++;
      if (reason === 'finished') finished = true;
      if (reason === 'quit') app.shouldQuit = true;
      if (reason === 'error') app.actionError = 'new error';
    },
    () => finished,
  );
  expect(calls).toBe(1);
  if (reason === 'error') expect(app.actionError).toBe('new error');
});

test.each(['\x1b[<0;30;10Mtext', '\x1b[<0;30;10M\x1b[<32;', 'café'])(
  'mixed/incomplete input stays intact: %j',
  (text) => {
    const input = Buffer.from(text);
    const calls: Buffer[] = [];
    dispatchInputBatch(state(), input, (report) => calls.push(report));
    expect(calls).toEqual([input]);
    expect(calls[0]).toBe(input);
  },
);
