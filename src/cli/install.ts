import { existsSync, mkdirSync, symlinkSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function fleetPluginDir(): string {
  return resolve(import.meta.dir, '../..');
}

function marketplaceDir(): string {
  return join(homedir(), '.local', 'share', 'fleet-marketplace');
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
  return install.exitCode ?? 1;
}

export function runUninstall(): number {
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
