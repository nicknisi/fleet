import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmux } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface InstalledPluginEntry {
  installPath?: string;
}

export function installedPluginHasHooks(pluginsRoot: string, prefix = 'fleet@'): boolean {
  const manifest = join(pluginsRoot, 'installed_plugins.json');
  if (!existsSync(manifest)) return false;

  let plugins: Record<string, InstalledPluginEntry[]>;
  try {
    plugins = JSON.parse(readFileSync(manifest, 'utf8')).plugins ?? {};
  } catch {
    return false;
  }

  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(prefix)) continue;
    for (const entry of entries) {
      if (entry.installPath && existsSync(join(entry.installPath, 'hooks', 'hooks.json'))) {
        return true;
      }
    }
  }
  return false;
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
  const pluginDir = join(home, '.claude', 'plugins');
  const pluginInstalled = existsSync(pluginDir);
  checks.push({
    name: 'plugin directory',
    ok: pluginInstalled,
    detail: pluginInstalled ? pluginDir : 'not found',
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
  const proc = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'list'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode === 0 && proc.stdout.toString().includes('fleet@')) {
    fleetInstalled = true;
  }
  checks.push({
    name: 'fleet plugin',
    ok: fleetInstalled,
    detail: fleetInstalled ? 'installed' : 'not installed (run: fleet install)',
  });

  const hasHooks = installedPluginHasHooks(pluginDir);
  checks.push({
    name: 'fleet hooks',
    ok: hasHooks,
    detail: hasHooks
      ? 'registered'
      : 'installed plugin has no hooks/hooks.json — dashboard will stay empty (reinstall: fleet install)',
  });

  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? '✓' : '✗';
    const color = check.ok ? '\x1b[32m' : '\x1b[31m';
    process.stdout.write(`${color}${icon}\x1b[0m ${check.name}: ${check.detail}\n`);
    if (!check.ok) allOk = false;
  }

  return allOk ? 0 : 1;
}
