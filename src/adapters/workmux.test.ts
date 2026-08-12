import { describe, expect, test } from 'bun:test';
import { parseWorkmuxStatus, indexWorkmux, matchWorkmux } from './workmux.ts';

describe('parseWorkmuxStatus', () => {
  test('top-level array of entries', () => {
    const s = parseWorkmuxStatus(
      JSON.stringify([
        { path: '/r/wt-a', handle: 'wt-a', pane: '%3' },
        { path: '/r/wt-b', name: 'wt-b' },
      ]),
    );
    expect(s.entries).toEqual([
      { path: '/r/wt-a', handle: 'wt-a', pane: '%3' },
      { path: '/r/wt-b', handle: 'wt-b', pane: null },
    ]);
  });

  test('parses workmux status --json agent entries', () => {
    const s = parseWorkmuxStatus(
      JSON.stringify({
        context: { backend: 'tmux', instance: 'default' },
        agents: [
          {
            worktree: 'feature-auth',
            workdir: '/r/worktrees/feature-auth',
            pane_id: '%9',
            window_name: 'wm-feature-auth',
          },
        ],
      }),
    );
    expect(s.entries).toEqual([{ path: '/r/worktrees/feature-auth', handle: 'feature-auth', pane: '%9' }]);
  });

  test('object with a worktrees array', () => {
    const s = parseWorkmuxStatus(JSON.stringify({ worktrees: [{ worktree: '/r/wt', session: 'sess' }] }));
    expect(s.entries).toEqual([{ path: '/r/wt', handle: 'sess', pane: null }]);
  });

  test('skips path-only rows rather than guessing an open handle', () => {
    const s = parseWorkmuxStatus(JSON.stringify([{ path: '/r/wt' }]));
    expect(s.entries).toEqual([]);
  });

  test('skips rows with no path', () => {
    const s = parseWorkmuxStatus(JSON.stringify([{ name: 'nope' }, { path: '/r/wt', handle: 'wt' }]));
    expect(s.entries).toHaveLength(1);
  });

  test('invalid JSON yields empty (never throws)', () => {
    expect(parseWorkmuxStatus('not json').entries).toEqual([]);
    expect(parseWorkmuxStatus('').entries).toEqual([]);
  });

  test('unexpected shape yields empty', () => {
    expect(parseWorkmuxStatus('42').entries).toEqual([]);
    expect(parseWorkmuxStatus('null').entries).toEqual([]);
  });
});

describe('matchWorkmux', () => {
  const status = parseWorkmuxStatus(
    JSON.stringify([
      { path: '/r/wt-a', handle: 'wt-a', pane: '%3' },
      { path: '/r/wt-b', handle: 'wt-b' },
    ]),
  );
  const index = indexWorkmux(status);

  test('pane id match requires path agreement', () => {
    expect(matchWorkmux(index, '%3', ['/r/wt-a'])?.handle).toBe('wt-a');
    expect(matchWorkmux(index, '%3', ['/elsewhere'])).toBeNull();
  });

  test('matches by worktree root when pane is unknown', () => {
    const hit = matchWorkmux(index, '%99', ['/r/wt-b']);
    expect(hit?.handle).toBe('wt-b');
  });

  test('null when nothing matches', () => {
    expect(matchWorkmux(index, '%99', ['/elsewhere', null, undefined])).toBeNull();
  });
});
