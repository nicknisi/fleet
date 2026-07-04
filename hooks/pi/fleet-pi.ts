/**
 * fleet-pi — a pi extension that publishes fleet agent-status from pi's
 * lifecycle events, so a pi session shows up on the fleet dashboard (working /
 * idle / done) alongside claude and codex.
 *
 * pi has no shell-hook config like Claude Code or Codex; it loads TypeScript
 * extensions auto-discovered from ~/.pi/agent/extensions/*.ts. `fleet install pi`
 * symlinks this file there. It subscribes to pi's lifecycle events and writes the
 * same status-file schema fleet's shell hooks write (see hooks/lib.sh):
 *
 *   agent_start          -> { state: "working" }
 *   tool_execution_start -> { state: "working", tool: "Bash: …" | "Edit: …" }
 *   agent_end            -> { state: "done" }        (fleet ages done -> idle)
 *   session_shutdown     -> remove the status file   (pi exited; no stale state)
 *
 * pi auto-runs its tools (no interactive permission prompt), so there is no
 * PERMIT/QUESTION state to source — working/done is complete coverage. State
 * goes to $FLEET_PI_STATUS_DIR or ~/.cache/pi-status (must match config.ts's
 * PI_STATUS_DIR). It is a no-op outside tmux, since fleet keys every agent on a
 * tmux pane. Every write is wrapped so a status-file error can never break pi.
 *
 * Zero fleet dependency: this file is loaded by pi, not bundled into fleet's
 * binary, and imports nothing from fleet. The pi API surface it uses is declared
 * locally (see PiExtensionAPI) rather than imported from
 * @mariozechner/pi-coding-agent, so fleet stays zero-dependency and typechecks
 * without pulling pi's types. pi invokes the default export with its real
 * ExtensionAPI, which structurally satisfies the local type.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --- minimal structural view of the pi ExtensionAPI slice this uses -----------
// pi's real handler signature is (event, ctx) => void | Promise<void>; narrower
// handlers (fewer params, void return) are assignable, so these compile against
// pi's real `on` at load time. See pi's docs/extensions.md for the full surface.
interface PiToolExecutionStartEvent {
  toolName: string;
  args: unknown;
}
interface PiExtensionAPI {
  on(event: 'session_start' | 'agent_start' | 'agent_end' | 'session_shutdown', handler: () => void): void;
  on(event: 'tool_execution_start', handler: (event: PiToolExecutionStartEvent) => void): void;
}

// --- pure helpers (exported for unit tests) -----------------------------------

// Enrich a pi tool call into a fleet activity label, matching the Claude/Codex
// convention: "Bash: <cmd>", "Edit: <file>". pi's built-in tool names are
// lowercase (bash, edit, write, read, …) with `command` (bash) or `path`
// (edit/write/read) inputs; anything else falls back to the capitalized name.
export function fleetPiLabel(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const cap = toolName ? toolName.charAt(0).toUpperCase() + toolName.slice(1) : '';
  if (toolName === 'bash') {
    const cmd = str(a.command).replace(/\s+/g, ' ').trim().slice(0, 48);
    return cmd ? `Bash: ${cmd}` : 'Bash';
  }
  if (toolName === 'edit' || toolName === 'write' || toolName === 'read') {
    const base = str(a.path).split('/').pop() ?? '';
    return base ? `${cap}: ${base}` : cap;
  }
  return cap;
}

// Serialize a fleet status record. JSON.stringify escapes quotes/newlines in the
// label so a status file can never be corrupted by tool input. Field names and
// shape mirror parseStatusFile in src/state/hooks.ts exactly.
export function buildPiStatusLine(
  state: string,
  pane: string,
  session: string,
  tool: string,
  ts: number,
  tmuxPid: number,
): string {
  return JSON.stringify({ state, pane, session, tool, ts, tmux_pid: tmuxPid }) + '\n';
}

// --- extension entry point ----------------------------------------------------
export default function (pi: PiExtensionAPI): void {
  const paneId = process.env.TMUX_PANE ?? '';
  // fleet keys every agent on a tmux pane; outside tmux there is nothing to
  // publish, so register no handlers (a clean no-op).
  if (!process.env.TMUX || !paneId) return;

  // Honor a caller-set override (tests), else the canonical dir config.ts reads.
  const statusDir = process.env.FLEET_PI_STATUS_DIR || join(homedir(), '.cache', 'pi-status');
  const paneNum = paneId.replace(/^%/, '');
  const statusFile = join(statusDir, `${paneNum}.status`);

  const tmuxQuery = (fmt: string): string => {
    try {
      return execFileSync('tmux', ['display-message', '-p', '-t', paneId, fmt], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  let session = tmuxQuery('#{session_name}');
  let tmuxPid = Number(tmuxQuery('#{pid}')) || 0;

  const write = (state: string, tool: string): void => {
    try {
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        statusFile,
        buildPiStatusLine(state, paneId, session, tool, Math.floor(Date.now() / 1000), tmuxPid),
      );
    } catch {
      // Never break the user's pi session over a status write.
    }
  };

  let currentTool = '';

  pi.on('session_start', () => {
    // tmux env is fully populated by now; backfill anything missing at load.
    if (!session) session = tmuxQuery('#{session_name}');
    if (!tmuxPid) tmuxPid = Number(tmuxQuery('#{pid}')) || 0;
  });
  pi.on('agent_start', () => write('working', currentTool));
  pi.on('tool_execution_start', (event) => {
    currentTool = fleetPiLabel(event.toolName, event.args);
    write('working', currentTool);
  });
  pi.on('agent_end', () => {
    currentTool = '';
    write('done', '');
  });
  pi.on('session_shutdown', () => {
    // pi is exiting — drop the status file so the pane doesn't linger as done.
    try {
      rmSync(statusFile, { force: true });
    } catch {
      // ignore
    }
  });
}
