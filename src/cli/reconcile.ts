import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentDirs } from '../agents/config.ts';
import { parseStatusFile, writeFileAtomic } from '../state/hooks.ts';
import { classifyPane, isDeletable, livePaneSet } from '../state/presence.ts';
import { listPanesResult } from '../tmux/sessions.ts';

export function runReconcile(dryRun: boolean, verbose: boolean): number {
  const dirs = loadAgentDirs();
  let removed = 0;
  let fixed = 0;
  const now = Math.floor(Date.now() / 1000);

  // ONE list-panes drives Present|Absent|Unknown for every tracked pane. A
  // failed query (tmux down) makes every pane Unknown, so the orphan sweep
  // deletes nothing this run — a transient failure must never wipe live state.
  // The old per-pane display-message conflated "pane dead" with "tmux down" and
  // would delete every status file the moment the server blinked.
  const live = livePaneSet(listPanesResult());

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
        // Invalid JSON is indeterminate, not proof that its pane is dead. A
        // concurrent/non-Fleet hook may be between truncate and write; retain
        // the file so a later pass can observe a complete record.
        log(`SKIP: ${path} (corrupt or incomplete status)`);
        continue;
      }

      if (status.pane) {
        const presence = classifyPane(status.pane, live);
        if (presence === 'unknown') {
          log(`SKIP: ${path} (pane ${status.pane} presence unknown — tmux unreachable)`);
          continue;
        }
        if (isDeletable(presence)) {
          // Close the snapshot/create race: confirm absence immediately before
          // deletion. Only two definitive Absent reads may remove state.
          const confirmed = classifyPane(status.pane, livePaneSet(listPanesResult()));
          if (!isDeletable(confirmed)) {
            log(`SKIP: ${path} (pane ${status.pane} absence was not confirmed)`);
            continue;
          }
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
            writeFileAtomic(path, JSON.stringify(data) + '\n');
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
