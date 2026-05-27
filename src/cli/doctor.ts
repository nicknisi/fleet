import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmux } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
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

  const hooksJson = join(import.meta.dir, '../../hooks/hooks.json');
  const hooksExist = existsSync(hooksJson);
  checks.push({
    name: 'hooks.json',
    ok: hooksExist,
    detail: hooksExist ? 'found' : 'missing',
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
