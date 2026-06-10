import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTmuxConfLine, removeTmuxConfLine, resolvePluginDir, tmuxConfPath } from './install.ts';

let workDir: string;
let confFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-install-test-'));
  confFile = join(workDir, 'tmux.conf');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('addTmuxConfLine', () => {
  test('returns false when file does not exist', () => {
    expect(addTmuxConfLine(join(workDir, 'missing.conf'))).toBe(false);
  });

  test('appends fleet-managed line to an existing config', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    expect(addTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).toContain('set -g mouse on');
    expect(result).toContain('# fleet-managed');
    expect(result).toContain('run-shell "fleet statusline --inject"');
    expect(result.endsWith('\n')).toBe(true);
  });

  test('is idempotent — does not duplicate the line', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    addTmuxConfLine(confFile);
    const after1 = readFileSync(confFile, 'utf8');
    expect(addTmuxConfLine(confFile)).toBe(true);
    const after2 = readFileSync(confFile, 'utf8');
    expect(after2).toBe(after1);
    const matches = after2.match(/# fleet-managed/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('handles empty file', () => {
    writeFileSync(confFile, '');
    expect(addTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).toContain('# fleet-managed');
  });

  test('handles file without trailing newline', () => {
    writeFileSync(confFile, 'set -g mouse on');
    expect(addTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).toContain('set -g mouse on');
    expect(result).toContain('# fleet-managed');
  });
});

describe('removeTmuxConfLine', () => {
  test('returns false when file does not exist', () => {
    expect(removeTmuxConfLine(join(workDir, 'missing.conf'))).toBe(false);
  });

  test('returns true and leaves file alone when marker absent', () => {
    const before = 'set -g mouse on\nset -g status-keys vi\n';
    writeFileSync(confFile, before);
    expect(removeTmuxConfLine(confFile)).toBe(true);
    expect(readFileSync(confFile, 'utf8')).toBe(before);
  });

  test('removes fleet-managed line', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    addTmuxConfLine(confFile);
    expect(readFileSync(confFile, 'utf8')).toContain('# fleet-managed');

    expect(removeTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).not.toContain('# fleet-managed');
    expect(result).not.toContain('run-shell "fleet statusline --inject"');
    expect(result).toContain('set -g mouse on');
  });

  test('collapses triple+ newlines to double', () => {
    writeFileSync(
      confFile,
      'set -g mouse on\n\n\nrun-shell "fleet statusline --inject" # fleet-managed\n\n\nset -g foo bar\n',
    );
    expect(removeTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('set -g mouse on');
    expect(result).toContain('set -g foo bar');
  });

  test('removes multiple fleet-managed lines if somehow present', () => {
    writeFileSync(
      confFile,
      'set -g mouse on\nrun-shell "fleet statusline --inject" # fleet-managed\nset -g foo bar\nrun-shell "other" # fleet-managed\n',
    );
    expect(removeTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).not.toContain('# fleet-managed');
    expect(result).toContain('set -g mouse on');
    expect(result).toContain('set -g foo bar');
  });
});

describe('resolvePluginDir', () => {
  test('returns null when no candidate has hooks/hooks.json', () => {
    const bare = join(workDir, 'bare');
    mkdirSync(bare, { recursive: true });
    expect(resolvePluginDir([bare])).toBe(null);
  });

  test('returns null for an empty candidate list', () => {
    expect(resolvePluginDir([])).toBe(null);
  });

  test('returns the candidate containing hooks/hooks.json', () => {
    const plugin = join(workDir, 'plugin');
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), '{}');
    expect(resolvePluginDir([plugin])).toBe(plugin);
  });

  test('skips candidates without hooks and returns the first that has them', () => {
    const bare = join(workDir, 'bare-keg');
    const plugin = join(workDir, 'dev-checkout');
    mkdirSync(bare, { recursive: true });
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), '{}');
    expect(resolvePluginDir([bare, plugin])).toBe(plugin);
  });
});

describe('tmuxConfPath', () => {
  test('returns a non-empty string ending in tmux.conf', () => {
    const path = tmuxConfPath();
    expect(path.length).toBeGreaterThan(0);
    expect(path.endsWith('tmux.conf')).toBe(true);
  });

  test('respects XDG_CONFIG_HOME when set and file exists there', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fleet-xdg-'));
    try {
      const tmuxDir = join(xdg, 'tmux');
      mkdirSync(tmuxDir, { recursive: true });
      const xdgConf = join(tmuxDir, 'tmux.conf');
      writeFileSync(xdgConf, '');

      const original = Bun.env.XDG_CONFIG_HOME;
      Bun.env.XDG_CONFIG_HOME = xdg;
      try {
        expect(tmuxConfPath()).toBe(xdgConf);
        expect(existsSync(xdgConf)).toBe(true);
      } finally {
        if (original === undefined) delete Bun.env.XDG_CONFIG_HOME;
        else Bun.env.XDG_CONFIG_HOME = original;
      }
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
