import { test, expect, describe } from 'bun:test';
import { classifyPane, isDeletable, livePaneSet } from './presence.ts';
import type { ListPanesResult } from '../tmux/sessions.ts';

function result(ok: boolean, paneIds: string[]): ListPanesResult {
  return {
    ok,
    // Only paneId matters to livePaneSet; the rest is padding for the type.
    panes: paneIds.map((paneId) => ({
      paneId,
      paneNum: Number(paneId.replace('%', '')),
      sessionName: 's',
      windowName: 'w',
      windowId: '@0',
      windowIndex: 0,
      currentPath: '/',
      panePid: 1,
      focused: false,
      paneTitle: '',
    })),
  };
}

describe('classifyPane', () => {
  test('present when the pane is in a successful list-panes result', () => {
    const live = livePaneSet(result(true, ['%1', '%2']));
    expect(classifyPane('%1', live)).toBe('present');
  });

  test('absent when tmux answered but the pane is gone', () => {
    const live = livePaneSet(result(true, ['%2']));
    expect(classifyPane('%1', live)).toBe('absent');
  });

  test('unknown when the list-panes query itself failed — never absent', () => {
    // A failed query carries no pane ids, but every tracked pane must resolve
    // to unknown, not absent: a transient tmux failure cannot look like a dead
    // pane or reconcile would delete every status file at once.
    const live = livePaneSet(result(false, []));
    expect(classifyPane('%1', live)).toBe('unknown');
    expect(classifyPane('%2', live)).toBe('unknown');
  });
});

describe('isDeletable', () => {
  test('only absent panes are deletable', () => {
    expect(isDeletable('absent')).toBe(true);
    expect(isDeletable('present')).toBe(false);
    expect(isDeletable('unknown')).toBe(false);
  });
});
