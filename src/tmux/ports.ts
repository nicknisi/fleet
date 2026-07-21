import { walkToPane } from '../agents/discovery.ts';

export interface PanePort {
  paneId: string;
  port: number;
}

// Map listening TCP ports to the tmux pane hosting the listener. `panePids`
// (pane_pid -> paneId) and `ppidByPid` come from the caller's single
// list-panes + ps pass, so this adds only the one `lsof` spawn.
export function detectPorts(panePids: Map<number, string>, ppidByPid: Map<number, number>): PanePort[] {
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
          const paneId = walkToPane(currentPid, ppidByPid, panePids);
          if (paneId) {
            results.push({ paneId, port });
          }
        }
      }
    }
  }

  return results;
}
