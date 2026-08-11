// `fleet notification-open <paneId> [socketPath] [terminalBundleId]` — the
// click handler for a native notification. Revalidates the pane, picks the
// most recently active non-control-mode client, activates the terminal FIRST,
// then jumps tmux to the exact pane. Stale/missing targets are silent no-ops
// (exit 0) so a click on a notification for a pane that has since closed does
// nothing rather than erroring.
//
// Structure: pure planners (arg parse + tmux arg builders + client picker) are
// exported for unit testing; `runNotificationOpen` is the thin shell that
// drives them through src/tmux/ipc.ts. Activation must precede the jump so the
// terminal is foregrounded before tmux moves the client.

import { tmux } from '../tmux/ipc.ts';

export interface OpenPaneArgs {
  paneId: string;
  socketPath: string; // '-' for unknown
  terminalBundleId: string; // '-' for unknown
}

export interface PaneRef {
  paneId: string;
  sessionName: string;
}

const PANE_REF_FORMAT = '#{pane_id}\t#{session_name}';
const CLIENT_FORMAT = '#{client_activity}\t#{client_name}\t#{client_flags}';

// A pane target is a tmux pane id: `%` followed by one or more digits.
export function validPane(pane: string): boolean {
  return /^%\d+$/.test(pane);
}

// Parse the CLI args. socketPath/bundleId default to '-' (unknown) when
// omitted. Invalid arity or a non-pane-id first arg → null (usage error).
export function parseOpenArgs(args: string[]): OpenPaneArgs | null {
  const [paneId, socketPath = '-', terminalBundleId = '-'] = args;
  if (!paneId || !validPane(paneId)) return null;
  return { paneId, socketPath, terminalBundleId };
}

// tmux socket args: pass `-S <socket>` only when a real socket is given. '-'
// means unknown (e.g. notification fired outside tmux's env), so fall back to
// the default socket by omitting -S entirely.
export function socketArgs(socketPath: string): string[] {
  return socketPath !== '-' && socketPath.length > 0 ? ['-S', socketPath] : [];
}

export function listPanesArgs(socketPath: string): string[] {
  return [...socketArgs(socketPath), 'list-panes', '-a', '-F', PANE_REF_FORMAT];
}

export function listClientsArgs(socketPath: string): string[] {
  return [...socketArgs(socketPath), 'list-clients', '-F', CLIENT_FORMAT];
}

// Parse list-panes output (pane_id\tsession_name) into refs. Lines with a
// missing field are dropped — a stray tab in a session name cannot shift the
// two columns here since pane_id is first and has no tabs.
export function parsePaneRefs(stdout: string): PaneRef[] {
  const refs: PaneRef[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    const paneId = parts[0];
    const sessionName = parts[1];
    if (paneId && sessionName && validPane(paneId)) {
      refs.push({ paneId, sessionName });
    }
  }
  return refs;
}

// Pick the highest-#{client_activity} client that is NOT in control-mode.
// control-mode clients (copy-mode-style read-only clients like fleet's own
// sidebar scraper) must never receive a switch-client. Returns null when no
// eligible client is attached.
export function pickClient(stdout: string): string | null {
  let best: { activity: number; name: string } | null = null;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    const activity = parseInt(parts[0] ?? '', 10);
    const name = parts[1];
    const flags = parts[2] ?? '';
    if (Number.isNaN(activity) || !name) continue;
    if (flags.split(',').includes('control-mode')) continue;
    if (best === null || activity > best.activity) {
      best = { activity, name };
    }
  }
  return best?.name ?? null;
}

// `open -b <bundleId>` activates the terminal. Returns null when bundleId is
// '-'/empty so the caller skips activation (unknown terminal).
export function activationCommand(bundleId: string): string[] | null {
  if (bundleId === '-' || bundleId.length === 0) return null;
  return ['open', '-b', bundleId];
}

// The exact-pane jump: switch the chosen client onto the pane's session, then
// select the pane's window and the pane itself. `;` joins the three tmux
// commands in one process (same shape as the reference open_pane).
export function jumpArgs(socketPath: string, client: string, paneId: string, sessionName: string): string[] {
  return [
    ...socketArgs(socketPath),
    'switch-client',
    '-c',
    client,
    '-t',
    sessionName,
    ';',
    'select-window',
    '-t',
    paneId,
    ';',
    'select-pane',
    '-t',
    paneId,
  ];
}

// Thin shell: drive the planners through tmux. Every failure path is a silent
// exit 0 (stale pane, no client, tmux down) so a notification click never
// surfaces an error to the user.
export function runNotificationOpen(args: string[]): number {
  const parsed = parseOpenArgs(args);
  if (!parsed) {
    process.stderr.write('Usage: fleet notification-open <paneId> [socketPath] [terminalBundleId]\n');
    return 1;
  }
  const { paneId, socketPath, terminalBundleId } = parsed;

  // Verify the pane still exists. Stale target → silent no-op.
  const panes = tmux(listPanesArgs(socketPath));
  if (panes.exitCode !== 0) return 0;
  const ref = parsePaneRefs(panes.stdout).find((p) => p.paneId === paneId);
  if (!ref) return 0;

  // Pick the most recently active real client. No client → silent no-op.
  const clients = tmux(listClientsArgs(socketPath));
  if (clients.exitCode !== 0) return 0;
  const client = pickClient(clients.stdout);
  if (!client) return 0;

  // Activate the terminal FIRST so the jump lands in a foreground window.
  const activate = activationCommand(terminalBundleId);
  if (activate) {
    Bun.spawnSync({ cmd: activate, stdout: 'ignore', stderr: 'ignore' });
  }

  // Then jump tmux to the exact pane.
  tmux(jumpArgs(socketPath, client, paneId, ref.sessionName));
  return 0;
}
