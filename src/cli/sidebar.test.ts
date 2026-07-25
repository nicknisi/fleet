import { describe, expect, test } from 'bun:test';
import { buildCloseArgs, buildFindArgs, buildMarkArgs, buildOpenArgs, SIDEBAR_WIDTH } from './sidebar.ts';

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
    expect(args).toEqual(['split-window', '-hbf', '-l', String(SIDEBAR_WIDTH), '-P', '-F', '#{pane_id}', 'fleet']);
  });

  test('targets the clicking pane’s window, with the command last', () => {
    const args = buildOpenArgs('%7');
    expect(args.slice(-3)).toEqual(['-t', '%7', 'fleet']);
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
