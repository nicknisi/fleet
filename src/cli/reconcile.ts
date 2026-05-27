import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmux } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';
import { parseStatusFile } from '../state/hooks.ts';

export function runReconcile(dryRun: boolean, verbose: boolean): number {
  const dirs = loadAgentDirs();
  let removed = 0;
  let fixed = 0;
  const now = Math.floor(Date.now() / 1000);

  const log = (msg: string) => {
    if (verbose) process.stdout.write(`${msg}\n`);
  };

  for (const dir of dirs) {
    if (!existsSync(dir.statusDir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir.statusDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      const path = join(dir.statusDir, file);
      let content: string;
      try {
        content = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }

      const status = parseStatusFile(content);
      if (!status) {
        log(`CORRUPT: ${path}`);
        if (!dryRun) rmSync(path, { force: true });
        removed++;
        continue;
      }

      if (status.pane) {
        const check = tmux(['display-message', '-t', status.pane, '-p', '#{pane_id}']);
        if (check.exitCode !== 0 || check.stdout.trim() === '') {
          log(`ORPHAN: ${path} (pane ${status.pane} dead)`);
          if (!dryRun) rmSync(path, { force: true });
          removed++;
          continue;
        }
      }

      if (status.state === 'working' && status.ts > 0) {
        const age = now - status.ts;
        if (age >= 180) {
          log(`STALE: ${path} (working for ${age}s)`);
          if (!dryRun) {
            const data = JSON.parse(content) as Record<string, unknown>;
            data.state = 'idle';
            writeFileSync(path, JSON.stringify(data) + '\n');
          }
          fixed++;
        }
      }
    }
  }

  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(`${prefix}Reconcile complete: ${removed} orphans removed, ${fixed} stale fixed\n`);
  return 0;
}
