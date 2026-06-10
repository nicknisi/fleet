import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runStatusLineInject, runStatusLineRemove } from './statusline.ts';

const FLEET_MANAGED_MARKER = '# fleet-managed';
const FLEET_TMUX_LINE = `run-shell "fleet statusline --inject" ${FLEET_MANAGED_MARKER}`;

export function resolvePluginDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    if (existsSync(join(dir, 'hooks', 'hooks.json'))) return dir;
  }
  return null;
}

function fleetPluginDir(): string | null {
  const fromBin = resolve(dirname(process.execPath), '..');
  const fromDev = resolve(import.meta.dir, '../..');
  return resolvePluginDir([fromBin, fromDev]);
}

function marketplaceDir(): string {
  return join(homedir(), '.local', 'share', 'fleet-marketplace');
}

export function tmuxConfPath(): string {
  const xdgConfig = Bun.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const xdgPath = join(xdgConfig, 'tmux', 'tmux.conf');
  if (existsSync(xdgPath)) return xdgPath;

  const legacyPath = join(homedir(), '.tmux.conf');
  if (existsSync(legacyPath)) return legacyPath;

  // Prefer XDG path even when neither exists — caller checks before writing.
  return xdgPath;
}

export function addTmuxConfLine(path: string = tmuxConfPath()): boolean {
  if (!existsSync(path)) return false;

  const contents = readFileSync(path, 'utf8');
  if (contents.includes(FLEET_MANAGED_MARKER)) return true;

  const separator = contents.length === 0 || contents.endsWith('\n') ? '\n' : '\n\n';
  const next = contents + separator + FLEET_TMUX_LINE + '\n';
  writeFileSync(path, next);
  return true;
}

export function removeTmuxConfLine(path: string = tmuxConfPath()): boolean {
  if (!existsSync(path)) return false;

  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(FLEET_MANAGED_MARKER)) return true;

  const filtered = contents
    .split('\n')
    .filter((line) => !line.includes(FLEET_MANAGED_MARKER))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  writeFileSync(path, filtered);
  return true;
}

function ensureMarketplace(fleetDir: string): string {
  const mpDir = marketplaceDir();
  const mpMeta = join(mpDir, '.claude-plugin');
  mkdirSync(mpMeta, { recursive: true });

  writeFileSync(
    join(mpMeta, 'marketplace.json'),
    JSON.stringify(
      {
        name: 'fleet-local',
        description: 'Local Fleet plugin marketplace',
        owner: { name: 'Nick Nisi', email: 'nick@nisi.org' },
        plugins: [{ name: 'fleet', source: './fleet', description: 'Agent dashboard TUI' }],
      },
      null,
      2,
    ) + '\n',
  );

  const link = join(mpDir, 'fleet');
  if (existsSync(link)) unlinkSync(link);
  symlinkSync(fleetDir, link);

  return mpDir;
}

export function runInstall(): number {
  const fleetDir = fleetPluginDir();
  if (fleetDir === null) {
    process.stderr.write(
      'fleet install failed: could not find a plugin directory containing hooks/hooks.json.\n' +
        'Without hooks, Claude Code writes no status files and the dashboard stays empty.\n' +
        'If fleet was installed via Homebrew, the package may be missing the hooks/ directory — try upgrading.\n',
    );
    return 1;
  }
  const mpDir = ensureMarketplace(fleetDir);

  const addMp = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'marketplace', 'add', mpDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (addMp.exitCode !== 0) {
    process.stderr.write('Failed to register fleet marketplace\n');
    return addMp.exitCode ?? 1;
  }

  const install = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'install', 'fleet'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (install.exitCode !== 0) return install.exitCode ?? 1;

  const confPath = tmuxConfPath();
  if (addTmuxConfLine(confPath)) {
    process.stdout.write(`Added fleet statusline hook to ${confPath}\n`);
  } else {
    process.stderr.write(`tmux.conf not found at ${confPath} — skipping tmux integration\n`);
  }

  runStatusLineInject();
  return 0;
}

export function runUninstall(): number {
  runStatusLineRemove();

  const confPath = tmuxConfPath();
  if (removeTmuxConfLine(confPath)) {
    process.stdout.write(`Removed fleet statusline hook from ${confPath}\n`);
  }

  const uninstall = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'uninstall', 'fleet'],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  Bun.spawnSync({
    cmd: ['claude', 'plugin', 'marketplace', 'remove', 'fleet-local'],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return uninstall.exitCode ?? 1;
}
