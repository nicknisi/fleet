import { describe, expect, test } from 'bun:test';
import { selectorKind, resolveSelector, describeSelector, type Selectable } from './selector.ts';

const item = (over: Partial<Selectable>): Selectable => ({
  paneId: '%1',
  windowId: '@1',
  session: 'api',
  window: 'main',
  ...over,
});

const world: Selectable[] = [
  item({ paneId: '%1', windowId: '@1', session: 'api', window: 'main' }),
  item({ paneId: '%2', windowId: '@1', session: 'api', window: 'main' }),
  item({ paneId: '%3', windowId: '@2', session: 'api', window: 'build' }),
  item({ paneId: '%4', windowId: '@3', session: 'db', window: 'main' }),
];

describe('selectorKind', () => {
  test('classifies each grammar branch by its leading token', () => {
    expect(selectorKind('%42')).toBe('pane');
    expect(selectorKind('@5')).toBe('window');
    expect(selectorKind('api:build')).toBe('session-window');
    expect(selectorKind('api')).toBe('session');
  });

  test('pane/window prefixes win over an embedded colon', () => {
    expect(selectorKind('%1:2')).toBe('pane');
    expect(selectorKind('@1:2')).toBe('window');
  });
});

describe('resolveSelector', () => {
  test('pane id matches exactly one pane', () => {
    const r = resolveSelector('%2', world);
    expect(r.kind).toBe('pane');
    expect(r.matches.map((m) => m.paneId)).toEqual(['%2']);
  });

  test('window id matches every pane in that window', () => {
    const r = resolveSelector('@1', world);
    expect(r.kind).toBe('window');
    expect(r.matches.map((m) => m.paneId)).toEqual(['%1', '%2']);
  });

  test('bare session matches every pane in the session', () => {
    const r = resolveSelector('api', world);
    expect(r.kind).toBe('session');
    expect(r.session).toBe('api');
    expect(r.matches.map((m) => m.paneId)).toEqual(['%1', '%2', '%3']);
  });

  test('session:window matches on both components', () => {
    const r = resolveSelector('api:build', world);
    expect(r.kind).toBe('session-window');
    expect(r.session).toBe('api');
    expect(r.window).toBe('build');
    expect(r.matches.map((m) => m.paneId)).toEqual(['%3']);
  });

  test('session:window keeps a window name that itself contains a colon', () => {
    const items = [item({ paneId: '%9', session: 'api', window: 'a:b' })];
    const r = resolveSelector('api:a:b', items);
    expect(r.session).toBe('api');
    expect(r.window).toBe('a:b');
    expect(r.matches.map((m) => m.paneId)).toEqual(['%9']);
  });

  test('no match returns an empty list, never throws', () => {
    expect(resolveSelector('%999', world).matches).toEqual([]);
    expect(resolveSelector('@999', world).matches).toEqual([]);
    expect(resolveSelector('nope', world).matches).toEqual([]);
    expect(resolveSelector('api:nope', world).matches).toEqual([]);
  });

  test('does not dedupe — a pane id present twice yields two matches', () => {
    const dupes = [item({ paneId: '%1' }), item({ paneId: '%1' })];
    expect(resolveSelector('%1', dupes).matches).toHaveLength(2);
  });

  test('carries raw through for error rendering', () => {
    expect(resolveSelector('api:build', world).raw).toBe('api:build');
  });
});

describe('describeSelector', () => {
  test('renders a natural phrase per kind', () => {
    expect(describeSelector({ raw: '%42', kind: 'pane' })).toBe("pane '%42'");
    expect(describeSelector({ raw: '@5', kind: 'window' })).toBe("window '@5'");
    expect(describeSelector({ raw: 'api:build', kind: 'session-window' })).toBe("session:window 'api:build'");
    expect(describeSelector({ raw: 'api', kind: 'session' })).toBe("session 'api'");
  });
});
