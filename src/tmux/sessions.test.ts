import { describe, expect, test } from 'bun:test';
import { listPanes } from './sessions.ts';

describe('listPanes', () => {
  test('returns array (may be empty if not in tmux)', () => {
    const panes = listPanes();
    expect(Array.isArray(panes)).toBe(true);
  });
});
