import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPluginHasHooks, marketplaceSourceOk } from './doctor.ts';

let pluginsRoot: string;

function writeInstalledPlugins(plugins: Record<string, Array<{ installPath: string }>>): void {
  writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

function makePluginDir(name: string, withHooks: boolean): string {
  const dir = join(pluginsRoot, 'cache', name);
  mkdirSync(withHooks ? join(dir, 'hooks') : dir, { recursive: true });
  if (withHooks) writeFileSync(join(dir, 'hooks', 'hooks.json'), '{}');
  return dir;
}

beforeEach(() => {
  pluginsRoot = mkdtempSync(join(tmpdir(), 'fleet-doctor-test-'));
});

afterEach(() => {
  rmSync(pluginsRoot, { recursive: true, force: true });
});

describe('installedPluginHasHooks', () => {
  test('returns false when installed_plugins.json is missing', () => {
    expect(installedPluginHasHooks(pluginsRoot)).toBe(false);
  });

  test('returns false when installed_plugins.json is malformed', () => {
    writeFileSync(join(pluginsRoot, 'installed_plugins.json'), 'not json');
    expect(installedPluginHasHooks(pluginsRoot)).toBe(false);
  });

  test('returns false when no plugin matches the prefix', () => {
    writeInstalledPlugins({
      'other@marketplace': [{ installPath: makePluginDir('other', true) }],
    });
    expect(installedPluginHasHooks(pluginsRoot)).toBe(false);
  });

  test('returns false when the installed plugin has no hooks/hooks.json', () => {
    writeInstalledPlugins({
      'fleet@fleet-local': [{ installPath: makePluginDir('fleet-bare', false) }],
    });
    expect(installedPluginHasHooks(pluginsRoot)).toBe(false);
  });

  test('returns true when the installed plugin ships hooks/hooks.json', () => {
    writeInstalledPlugins({
      'fleet@fleet-local': [{ installPath: makePluginDir('fleet-hooked', true) }],
    });
    expect(installedPluginHasHooks(pluginsRoot)).toBe(true);
  });

  test('returns true when any entry for the plugin has hooks', () => {
    writeInstalledPlugins({
      'fleet@fleet-local': [
        { installPath: makePluginDir('fleet-old', false) },
        { installPath: makePluginDir('fleet-new', true) },
      ],
    });
    expect(installedPluginHasHooks(pluginsRoot)).toBe(true);
  });

  test('respects a custom prefix', () => {
    writeInstalledPlugins({
      'custom@mp': [{ installPath: makePluginDir('custom', true) }],
    });
    expect(installedPluginHasHooks(pluginsRoot, 'custom@')).toBe(true);
    expect(installedPluginHasHooks(pluginsRoot, 'fleet@')).toBe(false);
  });
});

describe('marketplaceSourceOk', () => {
  test('returns true when the fleet source dir has hooks/hooks.json', () => {
    const src = join(pluginsRoot, 'fleet');
    mkdirSync(join(src, 'hooks'), { recursive: true });
    writeFileSync(join(src, 'hooks', 'hooks.json'), '{}');
    expect(marketplaceSourceOk(pluginsRoot)).toBe(true);
  });

  test('resolves through a healthy symlink (the fleet install layout)', () => {
    const keg = join(pluginsRoot, 'keg');
    mkdirSync(join(keg, 'hooks'), { recursive: true });
    writeFileSync(join(keg, 'hooks', 'hooks.json'), '{}');
    symlinkSync(keg, join(pluginsRoot, 'fleet'));
    expect(marketplaceSourceOk(pluginsRoot)).toBe(true);
  });

  test('returns false for a dangling symlink (keg removed by brew upgrade)', () => {
    symlinkSync(join(pluginsRoot, 'gone-keg'), join(pluginsRoot, 'fleet'));
    expect(marketplaceSourceOk(pluginsRoot)).toBe(false);
  });

  test('returns false when the source dir lacks hooks', () => {
    mkdirSync(join(pluginsRoot, 'fleet'), { recursive: true });
    expect(marketplaceSourceOk(pluginsRoot)).toBe(false);
  });
});
