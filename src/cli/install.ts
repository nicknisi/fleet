export function runInstall(): number {
  const pluginDir = import.meta.dir.replace(/\/src\/cli$/, '');
  const proc = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'install', pluginDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exitCode ?? 1;
}

export function runUninstall(): number {
  const pluginDir = import.meta.dir.replace(/\/src\/cli$/, '');
  const proc = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'uninstall', pluginDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exitCode ?? 1;
}
