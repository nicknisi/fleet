import { describe, expect, test } from 'bun:test';
import {
  attachArgs,
  captureCommands,
  childEnv,
  drainUntilMarker,
  nextSyncMarker,
  TmuxControlError,
} from './control.ts';

describe('attachArgs', () => {
  test('no $TMUX: plain -C attach-session -f no-output', () => {
    expect(attachArgs(undefined)).toEqual([
      'tmux',
      '-C',
      'attach-session',
      '-f',
      'no-output',
    ]);
  });

  test('with $TMUX: first comma-field becomes -S socket', () => {
    expect(attachArgs('/tmp/tmux-1000/default,12345,3')).toEqual([
      'tmux',
      '-S',
      '/tmp/tmux-1000/default',
      '-C',
      'attach-session',
      '-f',
      'no-output',
    ]);
  });

  test('empty socket field is skipped (no -S "")', () => {
    expect(attachArgs(',12345,3')).toEqual([
      'tmux',
      '-C',
      'attach-session',
      '-f',
      'no-output',
    ]);
  });
});

describe('childEnv', () => {
  test('removes TMUX, keeps everything else', () => {
    const out = childEnv({
      PATH: '/usr/bin',
      TMUX: '/tmp/x,1,2',
      HOME: '/home/me',
      EMPTY: undefined,
    });
    expect(out.TMUX).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/me');
    expect('EMPTY' in out).toBe(false);
  });
});

describe('nextSyncMarker', () => {
  test('is unique and monotonically tagged', () => {
    const a = nextSyncMarker();
    const b = nextSyncMarker();
    expect(a).toMatch(/^fleet-sync-\d+-\d+$/);
    expect(a).not.toBe(b);
  });
});

describe('captureCommands', () => {
  test('orders capture -> save -> delete with the shared buffer and temp file', () => {
    const [cap, save, del] = captureCommands('fleet-42', '%5', '/tmp/fleet-capture-42');
    expect(cap).toBe('capture-pane -b fleet-42 -t %5');
    expect(save).toBe('save-buffer -b fleet-42 /tmp/fleet-capture-42');
    expect(del).toBe('delete-buffer -b fleet-42');
  });
});

describe('drainUntilMarker (sync discard behavior)', () => {
  test('discards stale blocks until the marker body comes back', async () => {
    const bodies = ['stale-hook-output', 'another-stale', 'fleet-sync-1-1'];
    let i = 0;
    await drainUntilMarker(async () => bodies[i++]!, 'fleet-sync-1-1');
    expect(i).toBe(3);
  });

  test('resolves immediately when the first block is the marker', async () => {
    let calls = 0;
    await drainUntilMarker(async () => {
      calls++;
      return 'fleet-sync-2-1';
    }, 'fleet-sync-2-1');
    expect(calls).toBe(1);
  });

  test('body must match the marker EXACTLY (no trailing newline slip)', async () => {
    // A body with extra whitespace is NOT the marker — keep draining.
    const bodies = ['fleet-sync-3-1\n', 'fleet-sync-3-1'];
    let i = 0;
    await drainUntilMarker(async () => bodies[i++]!, 'fleet-sync-3-1');
    expect(i).toBe(2);
  });
});

describe('TmuxControlError', () => {
  test('carries a kind discriminator', () => {
    const e = new TmuxControlError('boom', 'error');
    expect(e.message).toBe('boom');
    expect(e.kind).toBe('error');
    expect(e.name).toBe('TmuxControlError');
    expect(e).toBeInstanceOf(Error);
  });
});
