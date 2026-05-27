import { describe, expect, test } from 'bun:test';
import { loadAgentDirs } from './config.ts';

describe('loadAgentDirs', () => {
  test('returns array of agent dirs', () => {
    const dirs = loadAgentDirs();
    expect(Array.isArray(dirs)).toBe(true);
    // Should find at least claude-status on this machine
    expect(dirs.length).toBeGreaterThan(0);
  });

  test('each dir has name and statusDir', () => {
    const dirs = loadAgentDirs();
    for (const dir of dirs) {
      expect(typeof dir.name).toBe('string');
      expect(typeof dir.statusDir).toBe('string');
    }
  });
});
