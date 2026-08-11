import { describe, expect, test } from 'bun:test';
import {
  activationCommand,
  jumpArgs,
  listClientsArgs,
  listPanesArgs,
  parseOpenArgs,
  parsePaneRefs,
  pickClient,
  socketArgs,
  validPane,
} from './notification-open.ts';

describe('validPane', () => {
  test('accepts % followed by digits', () => {
    expect(validPane('%0')).toBe(true);
    expect(validPane('%42')).toBe(true);
    expect(validPane('%99999')).toBe(true);
  });
  test('rejects non-pane targets', () => {
    expect(validPane('')).toBe(false);
    expect(validPane('%')).toBe(false);
    expect(validPane('%abc')).toBe(false);
    expect(validPane('42')).toBe(false);
    expect(validPane('main:0.1')).toBe(false);
    expect(validPane('%1a')).toBe(false);
  });
});

describe('parseOpenArgs', () => {
  test('parses paneId alone, defaulting socket/bundle to -', () => {
    expect(parseOpenArgs(['%7'])).toEqual({ paneId: '%7', socketPath: '-', terminalBundleId: '-' });
  });
  test('parses paneId + socket + bundle', () => {
    expect(parseOpenArgs(['%7', '/tmp/sock', 'com.apple.Terminal'])).toEqual({
      paneId: '%7',
      socketPath: '/tmp/sock',
      terminalBundleId: 'com.apple.Terminal',
    });
  });
  test('parses paneId + socket, defaulting bundle to -', () => {
    expect(parseOpenArgs(['%7', '/tmp/sock'])).toEqual({
      paneId: '%7',
      socketPath: '/tmp/sock',
      terminalBundleId: '-',
    });
  });
  test('rejects empty args and a non-pane first arg', () => {
    expect(parseOpenArgs([])).toBe(null);
    expect(parseOpenArgs(['not-a-pane'])).toBe(null);
    expect(parseOpenArgs(['7'])).toBe(null);
  });
});

describe('socketArgs', () => {
  test('omits -S for unknown / empty socket', () => {
    expect(socketArgs('-')).toEqual([]);
    expect(socketArgs('')).toEqual([]);
  });
  test('passes -S <socket> for a real socket', () => {
    expect(socketArgs('/tmp/tmux-1000/default')).toEqual(['-S', '/tmp/tmux-1000/default']);
  });
});

describe('listPanesArgs / listClientsArgs', () => {
  test('list-panes -a with the pane ref format', () => {
    expect(listPanesArgs('-')).toEqual(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}']);
  });
  test('prepends -S when a socket is known', () => {
    expect(listPanesArgs('/tmp/sock')).toEqual([
      '-S',
      '/tmp/sock',
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{session_name}',
    ]);
  });
  test('list-clients with the activity/name/flags format', () => {
    expect(listClientsArgs('-')).toEqual(['list-clients', '-F', '#{client_activity}\t#{client_name}\t#{client_flags}']);
  });
});

describe('parsePaneRefs', () => {
  test('parses pane_id and session_name columns', () => {
    const refs = parsePaneRefs('%5\tmain\n%7\tfeature-work\n');
    expect(refs).toEqual([
      { paneId: '%5', sessionName: 'main' },
      { paneId: '%7', sessionName: 'feature-work' },
    ]);
  });
  test('drops blank lines and rows missing a field', () => {
    const refs = parsePaneRefs('\n%5\t\nnot-a-pane\tmain\n%7\tmain\n');
    expect(refs).toEqual([{ paneId: '%7', sessionName: 'main' }]);
  });
});

describe('pickClient', () => {
  test('picks the highest-activity non-control-mode client', () => {
    const out = [
      '100\t/dev/ttys001\tfocus,read-only',
      '500\t/dev/ttys002\t',
      '300\t/dev/ttys003\tcontrol-mode',
      '400\t/dev/ttys004\t',
    ].join('\n');
    expect(pickClient(out)).toBe('/dev/ttys002');
  });
  test('ignores every control-mode client even if it has the highest activity', () => {
    const out = ['10\t/dev/ttys001\t', '999\t/dev/ttys002\tcontrol-mode'].join('\n');
    expect(pickClient(out)).toBe('/dev/ttys001');
  });
  test('returns null when no eligible client is attached', () => {
    expect(pickClient('')).toBe(null);
    expect(pickClient('1\t/dev/ttys001\tcontrol-mode')).toBe(null);
    expect(pickClient('notanumber\t/dev/ttys001\t')).toBe(null);
  });
});

describe('activationCommand', () => {
  test('open -b <bundleId> for a known bundle', () => {
    expect(activationCommand('com.apple.Terminal')).toEqual(['open', '-b', 'com.apple.Terminal']);
    expect(activationCommand('com.mitchellh.ghostty')).toEqual(['open', '-b', 'com.mitchellh.ghostty']);
  });
  test('null for unknown / empty bundle so activation is skipped', () => {
    expect(activationCommand('-')).toBe(null);
    expect(activationCommand('')).toBe(null);
  });
});

describe('jumpArgs', () => {
  test('switches the client onto the pane session, then selects window and pane', () => {
    expect(jumpArgs('-', '/dev/ttys001', '%7', 'main')).toEqual([
      'switch-client',
      '-c',
      '/dev/ttys001',
      '-t',
      'main',
      ';',
      'select-window',
      '-t',
      '%7',
      ';',
      'select-pane',
      '-t',
      '%7',
    ]);
  });
  test('prepends -S when a socket is known', () => {
    const args = jumpArgs('/tmp/sock', '/dev/ttys001', '%7', 'main');
    expect(args.slice(0, 2)).toEqual(['-S', '/tmp/sock']);
    expect(args[2]).toBe('switch-client');
  });
});
