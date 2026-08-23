import { walkToPane } from '../agents/discovery.ts';

export interface PanePort {
  paneId: string;
  port: number;
}

const LSOF_ARGS = ['lsof', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'];

// Parse lsof -F pn output into pane-port pairs (pure; shared by the sync and
// async detectPorts).
function parseLsofPorts(stdout: string, panePids: Map<number, string>, ppidByPid: Map<number, number>): PanePort[] {
  const results: PanePort[] = [];
  let currentPid = -1;

  for (const line of stdout.split('\n')) {
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

// Map listening TCP ports to the tmux pane hosting the listener. `panePids`
// (pane_pid -> paneId) and `ppidByPid` come from the caller's single
// list-panes + ps pass, so this adds only the one `lsof` spawn.
export function detectPorts(panePids: Map<number, string>, ppidByPid: Map<number, number>): PanePort[] {
  if (panePids.size === 0) return [];

  const proc = Bun.spawnSync({ cmd: LSOF_ARGS, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) return [];
  return parseLsofPorts(proc.stdout.toString(), panePids, ppidByPid);
}

// Async twin for the TUI slow tick: same parse, non-blocking fork. stderr is
// ignored — the sync path pipes but never reads it, and an unconsumed pipe can
// stall an async child.
export async function detectPortsAsync(
  panePids: Map<number, string>,
  ppidByPid: Map<number, number>,
): Promise<PanePort[]> {
  if (panePids.size === 0) return [];

  try {
    const proc = Bun.spawn({ cmd: LSOF_ARGS, stdout: 'pipe', stderr: 'ignore' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return [];
    return parseLsofPorts(stdout, panePids, ppidByPid);
  } catch {
    return [];
  }
}
