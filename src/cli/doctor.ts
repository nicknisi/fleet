import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmux, getTmuxOption } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';
import { marketplaceDir } from './install.ts';
import { isJsonObject, isString, type JsonValue } from '../json.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  // Advisory checks render a warning but never fail the overall exit code —
  // used for recommendations like enabling focus-events.
  advisory?: boolean;
}

function recordedPluginState(pluginsRoot: string, prefix = 'fleet@') {
  const result = { recorded: false, localMarketplace: false, malformed: false, hasHooks: false };
  try {
    // SAFETY: JSON.parse output is narrowed at this file boundary below.
    const manifest = JSON.parse(readFileSync(join(pluginsRoot, 'installed_plugins.json'), 'utf8')) as JsonValue;
    if (!isJsonObject(manifest) || !isJsonObject(manifest.plugins)) return result;
    for (const [key, entries] of Object.entries(manifest.plugins)) {
      if (!key.startsWith(prefix)) continue;
      result.recorded = true;
      if (key === 'fleet@fleet-local') result.localMarketplace = true;
      if (!Array.isArray(entries)) {
        result.malformed = true;
        continue;
      }
      for (const entry of entries) {
        if (!isJsonObject(entry) || (entry.installPath !== undefined && !isString(entry.installPath))) {
          result.malformed = true;
          continue;
        }
        if (entry.installPath && existsSync(join(entry.installPath, 'hooks', 'hooks.json'))) {
          result.hasHooks = true;
        }
      }
    }
  } catch {
    // Unreadable metadata cannot establish that a plugin is installed.
  }
  return result;
}

export function installedPluginHasHooks(pluginsRoot: string, prefix = 'fleet@'): boolean {
  const recorded = recordedPluginState(pluginsRoot, prefix);
  return recorded.hasHooks && !recorded.malformed;
}

// The global focus-events option gates per-client focus detection. With it
// off, every real client's selected pane is treated as focused (a coarser but
// still useful fallback). It's a recommendation, not a hard failure.
export function focusEventsOn(option: string | null): boolean {
  return option === 'on';
}

// e.g. a symlink into a Homebrew keg that `brew upgrade` deleted. Claude Code
// then drops the plugin at session start and hooks silently stop firing, while
// the cache-based check above still passes. existsSync follows symlinks, so a
// dangling link reads as missing. A recorded install also needs this source
// when the marketplace root itself is missing.
export function marketplaceSourceOk(mpDir: string): boolean {
  return existsSync(join(mpDir, 'fleet', 'hooks', 'hooks.json'));
}

export function runDoctor(): number {
  const checks: Check[] = [];

  const tmuxResult = tmux(['display-message', '-p', '#{version}']);
  checks.push({
    name: 'tmux',
    ok: tmuxResult.exitCode === 0,
    detail: tmuxResult.exitCode === 0 ? `v${tmuxResult.stdout.trim()}` : 'not running',
  });

  const home = homedir();
  const pluginDir = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins');
  const pluginInstalled = existsSync(pluginDir);
  checks.push({
    name: 'plugin directory',
    ok: pluginInstalled,
    advisory: true,
    detail: pluginInstalled ? pluginDir : `${pluginDir} (optional; native panes use discovery)`,
  });

  const dirs = loadAgentDirs();
  for (const dir of dirs) {
    const exists = existsSync(dir.statusDir);
    checks.push({
      name: `${dir.name} status dir`,
      ok: exists,
      detail: exists ? dir.statusDir : `${dir.statusDir} (missing)`,
    });
  }

  let fleetInstalled = false;
  let localMarketplaceInstalled = false;
  let pluginQueryOk = false;
  try {
    const proc = Bun.spawnSync({
      cmd: ['claude', 'plugin', 'list'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    pluginQueryOk = proc.exitCode === 0;
    fleetInstalled = pluginQueryOk && proc.stdout.toString().includes('fleet@');
    localMarketplaceInstalled = pluginQueryOk && proc.stdout.toString().split(/\s+/).includes('fleet@fleet-local');
  } catch {
    // Native discovery also works on machines without the Claude CLI.
  }
  checks.push({
    name: 'fleet plugin',
    ok: fleetInstalled,
    advisory: true,
    detail: fleetInstalled
      ? 'installed'
      : pluginQueryOk
        ? 'not installed; native panes use discovery (optional hooks: fleet install)'
        : 'could not query Claude plugins; native panes use discovery',
  });

  // Failed/missing CLI queries do not prove that a recorded install is absent.
  const recorded = recordedPluginState(pluginDir);
  const expectHooks = fleetInstalled || (!pluginQueryOk && recorded.recorded);
  if (expectHooks) {
    const hasHooks = recorded.hasHooks && !recorded.malformed;
    checks.push({
      name: 'fleet hooks',
      ok: hasHooks,
      detail: recorded.malformed
        ? `malformed Fleet metadata in ${join(pluginDir, 'installed_plugins.json')}; hook updates unavailable, native discovery still works (reinstall: fleet install)`
        : hasHooks
          ? 'registered'
          : 'installed plugin has no hooks/hooks.json; hook updates unavailable, native discovery still works (reinstall: fleet install)',
    });
  }

  const mpRoot = marketplaceDir();
  const rootExists = existsSync(mpRoot);
  // Only fleet install's own marketplace depends on this local source.
  const requireMarketplace = expectHooks && (pluginQueryOk ? localMarketplaceInstalled : recorded.localMarketplace);
  if (requireMarketplace || rootExists) {
    const sourceOk = marketplaceSourceOk(mpRoot);
    checks.push({
      name: 'marketplace source',
      ok: sourceOk,
      advisory: !requireMarketplace,
      detail: sourceOk
        ? join(mpRoot, 'fleet')
        : !rootExists
          ? `${mpRoot} (missing); installed plugin source unavailable (re-run: fleet install)`
          : `${join(mpRoot, 'fleet')} does not resolve — likely a symlink into a Homebrew keg removed by brew upgrade; hooks silently stop loading (re-run: fleet install)`,
    });
  }

  const focusEvents = getTmuxOption('focus-events');
  checks.push({
    name: 'focus-events',
    ok: focusEventsOn(focusEvents),
    advisory: true,
    detail: focusEventsOn(focusEvents)
      ? 'on'
      : `off — per-client focus detection needs 'set -g focus-events on' for accurate suppression`,
  });

  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? '✓' : check.advisory ? '!' : '✗';
    const color = check.ok ? '\x1b[32m' : check.advisory ? '\x1b[33m' : '\x1b[31m';
    process.stdout.write(`${color}${icon}\x1b[0m ${check.name}: ${check.detail}\n`);
    if (!check.ok && !check.advisory) allOk = false;
  }

  return allOk ? 0 : 1;
}
