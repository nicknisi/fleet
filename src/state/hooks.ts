import { readdirSync, readFileSync, existsSync, statSync, watch, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HookStatus, ResolvedHookStatus } from './types.ts';
import type { AgentDir } from '../agents/config.ts';

// The `.status` / `.events.jsonl` filename convention, named once. Keyed by the
// pane number (`%12` -> `12`), matching what hooks/lib.sh writes.
export function paneNum(paneId: string): string {
  return paneId.replace('%', '');
}

export function statusFilePath(dir: string, paneId: string): string {
  return join(dir, `${paneNum(paneId)}.status`);
}

export function eventsFilePath(dir: string, paneId: string): string {
  return join(dir, `${paneNum(paneId)}.events.jsonl`);
}

// Write-then-rename so a concurrent reader never sees a truncated file —
// rename is atomic within a filesystem.
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

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

// Parsed .status cache keyed by file path, gated on mtime: the fast tick
// re-reads every status file every 500ms, and they change far less often.
const statusCache = new Map<string, { mtimeMs: number; status: HookStatus | null }>();

// Each record is stamped with its owning `agent` and source `statusDir` so the
// caller (index.ts) knows which agent authored the status and which dir to read
// the matching .events.jsonl from — the name travels with the data.
export function readStatusDir(dir: string, agent: string): ResolvedHookStatus[] {
  if (!existsSync(dir)) return [];
  const statuses: ResolvedHookStatus[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      const path = join(dir, file);
      try {
        const mtimeMs = statSync(path).mtimeMs;
        const hit = statusCache.get(path);
        if (hit && hit.mtimeMs === mtimeMs) {
          if (hit.status) statuses.push({ ...hit.status, agent, statusDir: dir });
          continue;
        }
        const status = parseStatusFile(readFileSync(path, 'utf-8'));
        statusCache.set(path, { mtimeMs, status });
        if (status) statuses.push({ ...status, agent, statusDir: dir });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Dir listing failed
  }
  return statuses;
}

export function readAllStatusDirs(dirs: AgentDir[]): ResolvedHookStatus[] {
  const all: ResolvedHookStatus[] = [];
  for (const d of dirs) {
    all.push(...readStatusDir(d.statusDir, d.name));
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
