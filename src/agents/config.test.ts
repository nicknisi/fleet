import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_STATUS_DIR, loadAgentDirs } from './config.ts';

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

// Dir-drift guard: the read side (this constant, used by loadAgentDirs) must
// name the exact dir the write side (hooks/lib.sh's FLEET_STATUS_DIR default)
// creates. If they drift, adopting the documented config silently breaks Claude.
describe('CLAUDE_STATUS_DIR drift guard', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  test('equals the ~/.cache/claude-status dir the hook writes', () => {
    expect(CLAUDE_STATUS_DIR).toBe(join(homedir(), '.cache', 'claude-status'));
    expect(CLAUDE_STATUS_DIR.endsWith('/.cache/claude-status')).toBe(true);
  });

  test('the claude fallback, when present, uses the canonical constant', () => {
    // Point config discovery at a dir with no agents.json/agents.conf so
    // loadAgentDirs is forced down the hardcoded fallback branch.
    process.env.XDG_CONFIG_HOME = join(homedir(), '.cache', 'claude-status', '__fleet_no_config_here__');
    const claude = loadAgentDirs().find((d) => d.name === 'claude');
    if (claude) expect(claude.statusDir).toBe(CLAUDE_STATUS_DIR);
  });
});
