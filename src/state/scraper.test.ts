import { describe, expect, test } from 'bun:test';
import { detectFromPaneContent } from './scraper.ts';
import { AgentStatus } from './types.ts';

describe('detectFromPaneContent', () => {
  test('detects permission prompt [y/n]', () => {
    const lines = ['Some output...', '', 'Allow Edit to /path/file.ts?', '[y/n]'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects Y/n style permission', () => {
    const lines = ['Allow Read to /path?', '[Y/n]'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects Enter to select pattern', () => {
    const lines = ['Enter to select  ↑/↓  Esc to cancel  Tab to amend'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects working spinner', () => {
    const lines = ['✶ Thinking…', '', '❯'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.BUSY);
  });

  test('detects idle prompt', () => {
    const lines = ['Done! Created the file.', '', '❯'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.DONE);
  });

  test('returns null for unrecognized content', () => {
    const lines = ['$ ls', 'file1.ts', 'file2.ts'];
    expect(detectFromPaneContent(lines)).toBeNull();
  });
});
