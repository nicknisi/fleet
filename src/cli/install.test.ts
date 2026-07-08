import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTmuxConfLine,
  addTmuxKeybindLines,
  addTmuxRollupLines,
  linkPluginDir,
  removeTmuxConfLine,
  resolvePluginDir,
  stableKegPath,
  tmuxConfPath,
} from './install.ts';

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

  test('strips the three window-rollup lines added by addTmuxRollupLines', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    addTmuxRollupLines(confFile, () => true);
    expect(readFileSync(confFile, 'utf8')).toContain('@fleet_rollup');

    expect(removeTmuxConfLine(confFile)).toBe(true);
    const result = readFileSync(confFile, 'utf8');
    expect(result).not.toContain('# fleet-managed');
    expect(result).not.toContain('@fleet_rollup');
    expect(result).not.toContain('window-status-format');
    expect(result).not.toContain('window-status-current-format');
    expect(result).toContain('set -g mouse on');
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

describe('stableKegPath', () => {
  test('maps a versioned Cellar keg to the upgrade-stable opt path', () => {
    expect(stableKegPath('/opt/homebrew/Cellar/fleet/0.15.0')).toBe('/opt/homebrew/opt/fleet');
  });

  test('handles non-standard brew prefixes', () => {
    expect(stableKegPath('/home/linuxbrew/.linuxbrew/Cellar/fleet/1.2.3')).toBe('/home/linuxbrew/.linuxbrew/opt/fleet');
  });

  test('returns null for a non-Cellar path (dev checkout, plain install)', () => {
    expect(stableKegPath('/Users/nicknisi/Developer/fleet')).toBeNull();
    expect(stableKegPath('/usr/local/lib/fleet')).toBeNull();
  });

  test('returns null for a Cellar path without a version segment', () => {
    expect(stableKegPath('/opt/homebrew/Cellar/fleet')).toBeNull();
  });
});

describe('linkPluginDir', () => {
  test('creates a symlink to the plugin dir when none exists', () => {
    const target = join(workDir, 'plugin-0.10.0');
    const link = join(workDir, 'fleet');
    mkdirSync(target, { recursive: true });
    linkPluginDir(target, link);
    expect(readlinkSync(link)).toBe(target);
  });

  test('replaces an existing valid symlink', () => {
    const oldTarget = join(workDir, 'plugin-0.9.0');
    const newTarget = join(workDir, 'plugin-0.10.0');
    const link = join(workDir, 'fleet');
    mkdirSync(oldTarget, { recursive: true });
    mkdirSync(newTarget, { recursive: true });
    symlinkSync(oldTarget, link);
    linkPluginDir(newTarget, link);
    expect(readlinkSync(link)).toBe(newTarget);
  });

  test('replaces a dangling symlink left by a removed target (brew upgrade)', () => {
    const removedTarget = join(workDir, 'cellar-0.9.0'); // never created — simulates removed keg
    const newTarget = join(workDir, 'cellar-0.10.0');
    const link = join(workDir, 'fleet');
    mkdirSync(newTarget, { recursive: true });
    symlinkSync(removedTarget, link);
    expect(existsSync(link)).toBe(false); // the trap: existsSync follows the link and can't see it
    linkPluginDir(newTarget, link);
    expect(readlinkSync(link)).toBe(newTarget);
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

describe('addTmuxKeybindLines', () => {
  const confWith = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-test-'));
    const path = join(dir, 'tmux.conf');
    writeFileSync(path, content);
    return path;
  };

  test('accepting both prompts appends both managed bindings', () => {
    const path = confWith('set -g mouse on\n');
    const added = addTmuxKeybindLines(path, () => true);
    expect(added).toHaveLength(2);
    const conf = readFileSync(path, 'utf8');
    expect(conf).toContain('bind-key f split-window -hbf');
    expect(conf).toContain('bind-key F display-popup');
    expect(conf.match(/# fleet-managed/g)?.length).toBe(2);
  });

  test('declining adds nothing and leaves the file untouched', () => {
    const path = confWith('set -g mouse on\n');
    expect(addTmuxKeybindLines(path, () => false)).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('set -g mouse on\n');
  });

  test('idempotent: existing bindings are not re-added or re-asked', () => {
    const path = confWith('set -g mouse on\n');
    addTmuxKeybindLines(path, () => true);
    let asked = 0;
    const added = addTmuxKeybindLines(path, () => (asked++, true));
    expect(added).toHaveLength(0);
    expect(asked).toBe(0);
  });

  test('missing conf file adds nothing', () => {
    expect(addTmuxKeybindLines('/nonexistent/tmux.conf', () => true)).toHaveLength(0);
  });
});

describe('addTmuxRollupLines', () => {
  const confWith = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-rollup-test-'));
    const path = join(dir, 'tmux.conf');
    writeFileSync(path, content);
    return path;
  };

  test('accepting appends the gate option and both window-status format lines', () => {
    const path = confWith('set -g mouse on\n');
    const added = addTmuxRollupLines(path, () => true);
    expect(added).toHaveLength(3);
    const conf = readFileSync(path, 'utf8');
    expect(conf).toContain('set -g @fleet_rollup 1 # fleet-managed');
    expect(conf).toContain(
      'set -g window-status-format "#{?#{@fleet_state},#[fg=#{@fleet_state}],}#I:#W#F" # fleet-managed',
    );
    expect(conf).toContain(
      'set -g window-status-current-format "#{?#{@fleet_state},#[fg=#{@fleet_state}],}#[bold]#I:#W#F#[nobold]" # fleet-managed',
    );
    expect(conf.match(/# fleet-managed/g)?.length).toBe(3);
    expect(conf).toContain('set -g mouse on');
  });

  test('declining adds nothing and leaves the file untouched', () => {
    const path = confWith('set -g mouse on\n');
    expect(addTmuxRollupLines(path, () => false)).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('set -g mouse on\n');
  });

  test('idempotent: an already-configured conf is neither re-added nor re-asked', () => {
    const path = confWith('set -g mouse on\n');
    addTmuxRollupLines(path, () => true);
    const before = readFileSync(path, 'utf8');
    let asked = 0;
    const added = addTmuxRollupLines(path, () => (asked++, true));
    expect(added).toHaveLength(0);
    expect(asked).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('missing conf file adds nothing', () => {
    expect(addTmuxRollupLines('/nonexistent/tmux.conf', () => true)).toHaveLength(0);
  });
});

// Regression lock for "fleet install rewrote my tmux statusline". The two
// conf writers reachable from runInstall — addTmuxConfLine (unconditional) and
// addTmuxKeybindLines (only when the user accepts a prompt) — must never emit a
// window-status-format override. addTmuxRollupLines is the sole writer that
// does, and it is deliberately not wired into runInstall (see install.ts), so
// installing fleet cannot clobber a user's themed window formatting.
describe('install conf writers never touch window-status-format', () => {
  test('addTmuxConfLine adds only the statusline hook', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    addTmuxConfLine(confFile);
    const conf = readFileSync(confFile, 'utf8');
    expect(conf).toContain('run-shell "fleet statusline --inject"');
    expect(conf).not.toContain('window-status-format');
    expect(conf).not.toContain('@fleet_rollup');
  });

  test('accepting every keybind prompt still writes no window-status-format', () => {
    writeFileSync(confFile, 'set -g mouse on\n');
    addTmuxKeybindLines(confFile, () => true);
    const conf = readFileSync(confFile, 'utf8');
    expect(conf).toContain('bind-key');
    expect(conf).not.toContain('window-status-format');
    expect(conf).not.toContain('@fleet_rollup');
  });
});
