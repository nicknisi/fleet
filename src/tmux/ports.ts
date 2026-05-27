import { tmux } from './ipc.ts';

export interface PanePort {
  paneId: string;
  port: number;
}

export function detectPorts(): PanePort[] {
  const paneResult = tmux(['list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}']);
  if (paneResult.exitCode !== 0) return [];

  const panePids = new Map<number, string>();
  for (const line of paneResult.stdout.split('\n')) {
    if (line.length === 0) continue;
    const [paneId, pidStr] = line.split(':');
    if (paneId && pidStr) {
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) panePids.set(pid, paneId);
    }
  }

  if (panePids.size === 0) return [];

  const proc = Bun.spawnSync({
    cmd: ['lsof', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return [];

  const results: PanePort[] = [];
  let currentPid = -1;

  for (const line of proc.stdout.toString().split('\n')) {
    if (line.startsWith('p')) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith('n') && currentPid > 0) {
      const match = line.match(/:(\d+)$/);
      if (match) {
        const port = parseInt(match[1]!, 10);
        if (port >= 1024) {
          const paneId = findPaneForPid(currentPid, panePids);
          if (paneId) {
            results.push({ paneId, port });
          }
        }
      }
    }
  }

  return results;
}

function findPaneForPid(pid: number, panePids: Map<number, string>): string | null {
  let checkPid = pid;
  const visited = new Set<number>();
  while (checkPid > 1 && !visited.has(checkPid)) {
    visited.add(checkPid);
    const paneId = panePids.get(checkPid);
    if (paneId) return paneId;
    const proc = Bun.spawnSync({
      cmd: ['ps', '-o', 'ppid=', '-p', String(checkPid)],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) break;
    const ppid = parseInt(proc.stdout.toString().trim(), 10);
    if (Number.isNaN(ppid) || ppid <= 1) break;
    checkPid = ppid;
  }
  return null;
}
