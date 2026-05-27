import { readdirSync, readFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { HookStatus } from './types.ts';

export function parseStatusFile(content: string): HookStatus | null {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return {
      state: String(data.state ?? 'idle'),
      pane: String(data.pane ?? ''),
      session: String(data.session ?? ''),
      tool: String(data.tool ?? ''),
      ts: Number(data.ts ?? 0),
      tmux_pid: Number(data.tmux_pid ?? 0),
    };
  } catch {
    return null;
  }
}

export function readStatusDir(dir: string): HookStatus[] {
  if (!existsSync(dir)) return [];
  const statuses: HookStatus[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const status = parseStatusFile(content);
        if (status) statuses.push(status);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Dir listing failed
  }
  return statuses;
}

export function readAllStatusDirs(dirs: string[]): HookStatus[] {
  const all: HookStatus[] = [];
  for (const dir of dirs) {
    all.push(...readStatusDir(dir));
  }
  return all;
}

export type StatusChangeCallback = () => void;

export function watchStatusDirs(dirs: string[], onChange: StatusChangeCallback): () => void {
  const watchers: ReturnType<typeof watch>[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && (filename.endsWith('.status') || filename.endsWith('.jsonl'))) {
          onChange();
        }
      });
      watchers.push(watcher);
    } catch {
      // Skip unwatchable dirs
    }
  }
  return () => {
    for (const w of watchers) w.close();
  };
}
