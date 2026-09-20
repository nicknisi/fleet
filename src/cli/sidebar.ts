import { tmux, tmuxAsync, tmuxOrNull } from '../tmux/ipc.ts';

export const SIDEBAR_WIDTH = 34;
const SIDEBAR_OPTION = '@fleet_sidebar';
const CLIENT_OPTION = '@fleet_sidebar_client';
export const SIDEBAR_CLIENT_FORMAT =
  '#{client_pid}\t#{client_name}\t#{pane_id}\t#{window_id}\t#{client_flags}\t#{window_zoomed_flag}';

export interface SidebarClient {
  pid: string;
  name: string;
  pane: string;
  window: string;
  zoomed?: boolean;
}

export function sidebarClients(output: string): SidebarClient[] {
  const clients: SidebarClient[] = [];
  for (const line of output.split('\n')) {
    const [pid, name, pane, window, flags, zoomed] = line.split('\t');
    if (!pid || !/^\d+$/.test(pid) || !name || !pane || !/^%\d+$/.test(pane) || !window || !/^@\d+$/.test(window))
      continue;
    if (flags === undefined || flags.split(',').includes('control-mode')) continue;
    clients.push({ pid, name, pane, window, zoomed: zoomed === '1' });
  }
  return clients;
}

export function resolveSidebarClient(
  clients: SidebarClient[],
  target: string | null,
  name: string | null,
): SidebarClient | null {
  if (name !== null) return clients.find((c) => c.name === name) ?? null;
  const matching = target === null ? clients : clients.filter((c) => c.pane === target);
  // An ambiguous legacy binding must not move another client's sidebar.
  return matching.length === 1 ? matching[0]! : null;
}

export function buildFindArgs(target: string | null): string[] {
  const args = ['list-panes', '-f', `#{${SIDEBAR_OPTION}}`, '-F', '#{pane_id}'];
  if (target !== null) args.push('-t', target);
  return args;
}

export function buildOpenArgs(
  target: string | null,
  clientPid: string | null = null,
  command: string[] = ['fleet', '--sidebar'],
): string[] {
  const args = ['split-window', '-hbf', '-l', String(SIDEBAR_WIDTH), '-P', '-F', '#{pane_id}'];
  if (target !== null) args.push('-t', target);
  if (clientPid !== null) args.push('-e', `FLEET_SIDEBAR_CLIENT=${clientPid}`);
  args.push(...command);
  return args;
}

export function buildMarkArgs(paneId: string): string[] {
  return ['set', '-p', '-t', paneId, SIDEBAR_OPTION, '1'];
}

export function buildCloseArgs(paneId: string): string[] {
  return ['kill-pane', '-t', paneId];
}

interface SidebarPane {
  paneId: string;
  windowId: string;
}

function moveSidebarArgs(
  paneId: string,
  target: string,
  width: number,
  sourceWindow: string,
  sourceCount: number,
): string[] {
  const move = ['move-pane', '-d', '-hbf', '-l', String(Math.max(20, Math.floor(width))), '-s', paneId, '-t', target];
  if (sourceCount <= 2) return move; // only one ordinary pane remains: nothing to zoom
  // tmux move-pane unzooms the source. Evaluate zoom BEFORE moving and restore
  // it in the same command queue, without another observer poll or subprocess.
  return [
    'if-shell',
    '-F',
    '-t',
    paneId,
    '#{window_zoomed_flag}',
    `${move.join(' ')} ; resize-pane -Z -t ${sourceWindow}`,
    move.join(' '),
  ];
}

// Move the existing TUI, not its state: selection, filter and preview survive.
// -d preserves focus on the destination's agent; -f makes a full-height split.
// Never destroy a window/session implicitly by moving its only remaining pane.
export function buildFollowArgs(
  paneId: string,
  client: SidebarClient,
  panes: SidebarPane[],
  width: number,
): string[] | null {
  if (client.zoomed) return null; // never unzoom the user's work just to follow
  const source = panes.find((p) => p.paneId === paneId);
  const target = panes.find((p) => p.paneId === client.pane);
  if (!source || !target || source.windowId === target.windowId || target.windowId !== client.window) return null;
  const sourceCount = panes.filter((p) => p.windowId === source.windowId).length;
  if (sourceCount < 2) return null;
  return moveSidebarArgs(paneId, client.pane, width, source.windowId, sourceCount);
}

// Runs on the existing fast refresh, using the control connection when live.
// There is no extra poller/daemon and no subprocess on the control read path.
// Detached owners stay parked; a unique client returning to that window can
// reclaim the sidebar, without following arbitrary activity in another client.
export async function followSidebar(
  paneId: string,
  clientPid: string | null,
  panes: SidebarPane[],
  width: number,
  readClients: () => Promise<string> = async () =>
    (await tmuxAsync(['list-clients', '-F', SIDEBAR_CLIENT_FORMAT])).stdout,
): Promise<string | null> {
  try {
    const clients = sidebarClients(await readClients());
    let owner = clients.find((c) => c.pid === clientPid);
    if (!owner) {
      const window = panes.find((p) => p.paneId === paneId)?.windowId;
      const candidates = clients.filter((c) => c.window === window);
      if (candidates.length !== 1) return clientPid;
      owner = candidates[0]!;
      await tmuxAsync(['set', '-p', '-t', paneId, CLIENT_OPTION, owner.pid]);
    }
    const args = buildFollowArgs(paneId, owner, panes, width);
    if (args) await tmuxAsync(args);
    return owner.pid;
  } catch {
    // A missing client/pane or unavailable control connection must not end the TUI.
    return clientPid;
  }
}

// A compiled binary launches itself; source development launches the same Bun
// entrypoint. Multiple argv items avoid shell interpretation of installation paths.
function sidebarCommand(): string[] {
  return Bun.main.startsWith('/$bunfs/') ? [process.execPath, '--sidebar'] : [process.execPath, Bun.main, '--sidebar'];
}

export function toggleSidebar(target: string | null, clientName: string | null = null): number {
  if (target !== null && !/^%\d+$/.test(target)) {
    process.stderr.write('fleet sidebar: --from must be a pane id\n');
    return 1;
  }
  const clients = sidebarClients(tmuxOrNull(['list-clients', '-F', SIDEBAR_CLIENT_FORMAT]) ?? '');
  const client = resolveSidebarClient(clients, target, clientName);
  if (!client && (clientName !== null || clients.length > 0)) {
    process.stderr.write('fleet sidebar: cannot identify the invoking client; pass --client <client-name>\n');
    return 1;
  }
  const from = target ?? client?.pane ?? null;
  // One long-lived TUI per invoking client, rather than one scanner per window.
  const found = client
    ? tmuxOrNull([
        'list-panes',
        '-a',
        '-f',
        `#{&&:#{${SIDEBAR_OPTION}},#{==:#{${CLIENT_OPTION}},${client.pid}}}`,
        '-F',
        '#{pane_id}',
      ])
    : tmuxOrNull(buildFindArgs(from));
  if (found !== null) {
    const pane = found.split('\n')[0]!;
    if (pane === from) {
      tmux(buildCloseArgs(pane));
    } else {
      // Re-enter navigation without tearing down the sidebar. Its fast refresh
      // normally already moved it; explicitly move before focus if still behind.
      if (from !== null) {
        const location = tmuxOrNull([
          'display-message',
          '-p',
          '-t',
          pane,
          '#{window_id}\t#{window_panes}\t#{pane_width}',
        ]);
        const destination = tmuxOrNull(['display-message', '-p', '-t', from, '#{window_id}']);
        const [window, count, width] = (location ?? '').split('\t');
        if (window !== destination && Number(count) > 1) {
          tmux(moveSidebarArgs(pane, from, Number(width) || SIDEBAR_WIDTH, window!, Number(count)));
        }
      }
      // switch-client is exact-client scoped; never choose the most recent one.
      if (client) tmux(['switch-client', '-c', client.name, '-t', pane]);
      tmux(['select-pane', '-t', pane]);
    }
    return 0;
  }

  const created = tmuxOrNull(buildOpenArgs(from, client?.pid ?? null, sidebarCommand()));
  if (created === null) {
    process.stderr.write('fleet sidebar: split-window failed (not inside tmux?)\n');
    return 1;
  }
  tmux(buildMarkArgs(created));
  if (client) tmux(['set', '-p', '-t', created, CLIENT_OPTION, client.pid]);
  return 0;
}

export function runSidebar(args: string[]): number {
  const fromIndex = args.indexOf('--from');
  const clientIndex = args.indexOf('--client');
  return toggleSidebar(
    fromIndex !== -1 ? (args[fromIndex + 1] ?? null) : null,
    clientIndex !== -1 ? (args[clientIndex + 1] ?? null) : null,
  );
}
