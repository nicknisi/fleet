import { describe, expect, test } from 'bun:test';
import {
  buildCloseArgs,
  buildFindArgs,
  buildFollowArgs,
  buildMarkArgs,
  buildOpenArgs,
  resolveSidebarClient,
  sidebarClients,
  SIDEBAR_WIDTH,
} from './sidebar.ts';

describe('buildFindArgs', () => {
  test('filters panes by the fleet marker option', () => {
    const args = buildFindArgs(null);
    expect(args).toEqual(['list-panes', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}']);
  });

  test('scopes the search to the target pane’s window', () => {
    expect(buildFindArgs('%7')).toEqual(['list-panes', '-f', '#{@fleet_sidebar}', '-F', '#{pane_id}', '-t', '%7']);
  });
});

describe('buildOpenArgs', () => {
  test('splits full-height on the left and prints the new pane id', () => {
    const args = buildOpenArgs(null);
    expect(args).toEqual([
      'split-window',
      '-hbf',
      '-l',
      String(SIDEBAR_WIDTH),
      '-P',
      '-F',
      '#{pane_id}',
      'fleet',
      '--sidebar',
    ]);
  });

  test('targets the clicking pane’s window, with the command last', () => {
    const args = buildOpenArgs('%7');
    expect(args.slice(-4)).toEqual(['-t', '%7', 'fleet', '--sidebar']);
  });
});

describe('buildMarkArgs', () => {
  test('sets the marker pane-scoped so list-panes -f can find it', () => {
    // -p is what makes this a pane option; -g or -w here would leak the marker
    // to every pane and make the toggle think a sidebar is always open.
    expect(buildMarkArgs('%9')).toEqual(['set', '-p', '-t', '%9', '@fleet_sidebar', '1']);
  });
});

describe('buildCloseArgs', () => {
  test('kills the marked pane by id', () => {
    expect(buildCloseArgs('%9')).toEqual(['kill-pane', '-t', '%9']);
  });
});

describe('persistent sidebar ownership', () => {
  const clients = sidebarClients(
    '123\t/dev/ttys1\t%1\t@1\tfocused\n456\t/dev/ttys2\t%2\t@2\t\n999\tcontrol\t%3\t@1\tcontrol-mode\nbad',
  );
  test('only real clients can own a sidebar', () => {
    expect(clients).toHaveLength(2);
    expect(resolveSidebarClient(clients, '%1', null)?.pid).toBe('123');
    expect(resolveSidebarClient(clients, null, '/dev/ttys2')?.pid).toBe('456');
    expect(resolveSidebarClient(clients, null, null)).toBeNull();
    expect(resolveSidebarClient(clients, '%1', 'unknown')).toBeNull();
    expect(resolveSidebarClient([...clients, { ...clients[1]!, pane: '%1' }], '%1', null)).toBeNull();
  });
  test('the owner is passed to the TUI without shell interpolation', () => {
    const args = buildOpenArgs('%1', '123', ['/path with spaces/fleet', '--sidebar']);
    expect(args.slice(-4)).toEqual(['-e', 'FLEET_SIDEBAR_CLIENT=123', '/path with spaces/fleet', '--sidebar']);
  });
  const panes = [
    { paneId: '%9', windowId: '@1' },
    { paneId: '%1', windowId: '@1' },
    { paneId: '%2', windowId: '@2' },
  ];
  test('moves the same pane left at its current width, without taking focus', () => {
    expect(buildFollowArgs('%9', clients[1]!, panes, 41)).toEqual([
      'move-pane',
      '-d',
      '-hbf',
      '-l',
      '41',
      '-s',
      '%9',
      '-t',
      '%2',
    ]);
  });
  test('does nothing in the current window or with missing/stale targets', () => {
    expect(buildFollowArgs('%9', clients[0]!, panes, 34)).toBeNull();
    expect(buildFollowArgs('%9', { ...clients[1]!, pane: '%404' }, panes, 34)).toBeNull();
    expect(buildFollowArgs('%404', clients[1]!, panes, 34)).toBeNull();
    expect(buildFollowArgs('%9', { ...clients[1]!, window: '@3' }, panes, 34)).toBeNull();
  });
  test('never moves the only pane out of a window, implicitly destroying it', () => {
    expect(
      buildFollowArgs(
        '%9',
        clients[1]!,
        panes.filter((p) => p.paneId !== '%1'),
        34,
      ),
    ).toBeNull();
  });
});
