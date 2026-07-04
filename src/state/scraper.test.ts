import { describe, expect, test } from 'bun:test';
import { detectFromPaneContent } from './scraper.ts';
import { AgentStatus } from './types.ts';

describe('detectFromPaneContent', () => {
  test('detects permission prompt [y/n]', () => {
    const lines = ['Some output...', '', 'Allow Edit to /path/file.ts?', '[y/n]'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.PERMIT);
    expect(result.ruleId).toBe('permit.yn');
  });

  test('detects Y/n style permission', () => {
    const lines = ['Allow Read to /path?', '[Y/n]'];
    expect(detectFromPaneContent(lines).status).toBe(AgentStatus.PERMIT);
  });

  test('detects Enter to select as QUESTION', () => {
    const lines = ['1. Option A', '2. Option B', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.QUESTION);
    expect(result.ruleId).toBe('question.enter-select');
  });

  test('detects working via token counter (minutes)', () => {
    const lines = ['✻ Trapping Gollum… (1m 11s · ↓ 3.4k tokens)', '', '❯'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.ruleId).toBe('busy.token-counter-min');
  });

  test('detects working via token counter (seconds only)', () => {
    const lines = ['✢ Sharting… (8s · ↑ 240 tokens)', '', '❯'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.ruleId).toBe('busy.token-counter-sec');
  });

  test('detects working via esc to interrupt', () => {
    const lines = ['Running command…', '', '(esc to interrupt)', '❯'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.BUSY);
    expect(result.ruleId).toBe('busy.esc-interrupt');
  });

  test('detects idle prompt as IDLE', () => {
    const lines = ['Done! Created the file.', '', '❯'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBe(AgentStatus.IDLE);
    expect(result.ruleId).toBe('idle.prompt');
  });

  test('animated spinner glyph alone is not enough — needs counter', () => {
    // A bare spinner verb with no counter and a visible prompt reads as IDLE,
    // and the fusion engine keeps a fresh hook BUSY from being overridden.
    const lines = ['✶ Thinking…', '', '❯'];
    expect(detectFromPaneContent(lines).status).toBe(AgentStatus.IDLE);
  });

  test('returns null for unrecognized content', () => {
    const lines = ['$ ls', 'file1.ts', 'file2.ts'];
    const result = detectFromPaneContent(lines);
    expect(result.status).toBeNull();
    expect(result.ruleId).toBeNull();
  });
});
