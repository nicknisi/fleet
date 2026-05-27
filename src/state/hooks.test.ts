import { describe, expect, test } from 'bun:test';
import { parseStatusFile, readStatusDir } from './hooks.ts';

describe('parseStatusFile', () => {
  test('parses valid status JSON', () => {
    const content = '{"state":"working","pane":"%42","session":"dotfiles","tool":"Edit","ts":1748380000,"tmux_pid":12345}';
    const status = parseStatusFile(content);
    expect(status).not.toBeNull();
    expect(status!.state).toBe('working');
    expect(status!.pane).toBe('%42');
    expect(status!.session).toBe('dotfiles');
    expect(status!.tool).toBe('Edit');
  });

  test('returns null for invalid JSON', () => {
    expect(parseStatusFile('not json')).toBeNull();
    expect(parseStatusFile('')).toBeNull();
  });
});

describe('readStatusDir', () => {
  test('returns empty for non-existent dir', () => {
    expect(readStatusDir('/tmp/nonexistent-fleet-test-dir')).toEqual([]);
  });
});
