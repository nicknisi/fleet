import { describe, expect, test } from 'bun:test';
import { createRefreshQueue } from './refresh-queue.ts';

describe('refresh queue', () => {
  test('coalesces events during a scan without overlap or losing slow work', async () => {
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: boolean[] = [];
    let active = 0;
    let maxActive = 0;
    const queue = createRefreshQueue(async (slow) => {
      calls.push(slow);
      active++;
      maxActive = Math.max(active, maxActive);
      if (calls.length === 1) await first;
      active--;
    });
    const done = queue.request();
    for (let i = 0; i < 20; i++) void queue.request();
    void queue.request(true);
    void queue.request();
    release();
    await done;
    expect(calls).toEqual([false, true]);
    expect(maxActive).toBe(1);
  });
  test('an error does not discard a pending wake', async () => {
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const queue = createRefreshQueue(async () => {
      count++;
      if (count === 1) {
        await first;
        throw new Error('tmux unavailable');
      }
    });
    const done = queue.request(true);
    void queue.request();
    release();
    await done;
    expect(count).toBe(2);
  });
  test('stop drops pending work and refuses future requests', async () => {
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const queue = createRefreshQueue(async () => {
      count++;
      await first;
    });
    const done = queue.request();
    void queue.request(true);
    queue.stop();
    release();
    await done;
    await queue.request();
    expect(count).toBe(1);
  });
});
