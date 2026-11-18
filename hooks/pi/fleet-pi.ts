/**
 * fleet-pi — a pi extension that publishes fleet agent-status from pi's
 * lifecycle events, so a pi session shows up on the fleet dashboard (working /
 * idle / done) alongside claude and codex.
 *
 * pi has no shell-hook config like Claude Code or Codex; `fleet install pi`
 * registers this directory as a local pi package (see package.json next to this
 * file). It subscribes to pi's lifecycle events and writes the
 * same status-file schema fleet's shell hooks write (see hooks/lib.sh):
 *
 *   session_start                  -> { state: "idle" }        (carries the session name on reload/resume)
 *   agent_start, turn_start        -> { state: "working" }  (plus a heartbeat while pi works, see below)
 *   tool_execution_start           -> { state: "working", tool: "Bash: …" | "Edit: …" }
 *   tool_call (question tool)      -> { state: "question" }
 *   tool_execution_end (question)  -> { state: "working" }
 *   rpiv:ask-user:blocked (active)  -> { state: "question" }
 *   rpiv:ask-user:blocked (cleared) -> { state: "working" }
 *   ui_prompt_start (confirm)       -> { state: "permit" }   (a pi dialog waits on the user)
 *   ui_prompt_start (other kinds)   -> { state: "question" }
 *   ui_prompt_end                   -> back to "working" mid-run, else the state before the prompt
 *   agent_settled                  -> { state: "done" }      (fleet ages done -> idle)
 *   agent_end                      -> "done" 3s later unless pi starts again (retry, follow-up)
 *                                     or settles first; covers pi builds without agent_settled
 *   session_info_changed           -> rewrite current state carrying pi's session name
 *   session_shutdown               -> remove the status file (pi exited; no stale state)
 *
 * pi auto-runs its tools, but extensions can open blocking dialogs (confirm,
 * select, input, editor, custom); pi brackets those with ui_prompt_start /
 * ui_prompt_end, which map to permit (confirm) or question. Question tools can
 * also block on user input; @juicesharp/rpiv-ask-user-question
 * publishes that interval on pi's shared event bus, and compatibility-shimmed
 * AskUserQuestion tools are recognized from their tool_call lifecycle. State goes to
 * $FLEET_PI_STATUS_DIR or ~/.cache/pi-status (must match config.ts's
 * PI_STATUS_DIR). It is a no-op outside tmux, since fleet keys every agent on a
 * tmux pane. Every write is wrapped so a status-file error can never break pi.
 *
 * While a run is in progress, "working" is re-stamped every 60s, so a long
 * generation with no tool calls never ages past fleet's 180s working timeout.
 * That used to lean on scraping a composer spinner row, which depends on how
 * the user's composer is styled.
 *
 * permit, question and done also notify, mirroring fleet_notify in
 * hooks/lib.sh: a 3s tmux message unless this pane is the one in view, plus a
 * bell for other sessions when @fleet_bell is on. Notifying never blocks pi.
 *
 * Zero fleet dependency: this file is loaded by pi, not bundled into fleet's
 * binary, and imports nothing from fleet. The pi API surface it uses is declared
 * locally (see PiExtensionAPI) rather than imported from
 * @mariozechner/pi-coding-agent, so fleet stays zero-dependency and typechecks
 * without pulling pi's types. pi invokes the default export with its real
 * ExtensionAPI, which structurally satisfies the local type.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --- minimal structural view of the pi ExtensionAPI slice this uses -----------
// pi's real handler signature is (event, ctx) => void | Promise<void>; narrower
// handlers (fewer params, void return) are assignable, so these compile against
// pi's real `on` at load time. See pi's docs/extensions.md for the full surface.
//
// Local copy of fleet's JsonValue boundary type (src/json.ts): this file is
// loaded standalone by pi and imports nothing from fleet (see header), so the
// type is duplicated here rather than imported.
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

type PiToolExecutionStartEvent = {
  toolName: string;
  args: JsonValue;
};
type PiToolEvent = {
  toolName: string;
};
interface PiExtensionAPI {
  on(
    event: 'session_start' | 'agent_start' | 'agent_end' | 'agent_settled' | 'turn_start' | 'session_shutdown',
    handler: () => void,
  ): void;
  on(event: 'tool_execution_start', handler: (event: PiToolExecutionStartEvent) => void): void;
  on(event: 'tool_call' | 'tool_execution_end', handler: (event: PiToolEvent) => void): void;
  on(event: 'session_info_changed', handler: (event: { name?: string }) => void): void;
  on(event: 'ui_prompt_start', handler: (event: { kind: string; title?: string }) => void): void;
  on(event: 'ui_prompt_end', handler: () => void): void;
  // pi names sessions (auto-named after the first turn, renameable via /name);
  // optional so the extension still loads on a pi build that predates it.
  getSessionName?(): string | undefined;
  events?: {
    on(event: 'rpiv:ask-user:blocked', handler: (payload: { active: boolean }) => void): void;
  };
}

// --- pure helpers (exported for unit tests) -----------------------------------

// Enrich a pi tool call into a fleet activity label, matching the Claude/Codex
// convention: "Bash: <cmd>", "Edit: <file>". pi's built-in tool names are
// lowercase (bash, edit, write, read, …) with `command` (bash) or `path`
// (edit/write/read) inputs; anything else falls back to the capitalized name.
const QUESTION_TOOL_LABEL = 'Ask User Question';

// Claude Code compatibility shims expose `AskUserQuestion`; the native pi
// package exposes `ask_user_question`. The RPIV package also emits a precise
// blocked event, but this lifecycle fallback covers shims that emit nothing.
export function isPiQuestionTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'askuserquestion' || normalized === 'ask_user_question';
}

export function fleetPiLabel(toolName: string, args: JsonValue | undefined): string {
  const a: JsonObject = isJsonObject(args) ? args : {};
  const str = (v: JsonValue | undefined): string => (isString(v) ? v : '');
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

// fleet state for a blocking pi dialog: a confirm asks for permission,
// everything else (select, input, editor, custom) is a question.
export function piPromptState(kind: string): 'permit' | 'question' {
  return kind === 'confirm' ? 'permit' : 'question';
}

// The tmux message fleet_notify shows (hooks/lib.sh), or '' for states that
// don't notify.
export function fleetNotifyMessage(state: string, session: string, tool = ''): string {
  if (!['permit', 'question', 'done', 'waiting', 'completed'].includes(state)) return '';
  const icon =
    state === 'permit' ? '⚠' : state === 'question' ? '?' : state === 'done' || state === 'completed' ? '✓' : '⏳';
  return tool ? `${icon} ${session} (${tool})` : `${icon} ${session}`;
}

// tmux expands formats in display-message text, and `#(cmd)` runs a shell
// command; dialog titles can carry model text. Doubling `#` makes tmux print
// it literally, on every tmux version (display-message -l is newer).
export function tmuxLiteral(text: string): string {
  return text.replace(/#/g, '##');
}

// Serialize a fleet status record. JSON.stringify escapes quotes/newlines in the
// label so a status file can never be corrupted by tool input. Field names and
// shape mirror parseStatusFile in src/state/hooks.ts exactly. `name` is pi's own
// session name ('' when unnamed) — fleet prefers it over the tmux window label.
export function buildPiStatusLine(
  state: string,
  pane: string,
  session: string,
  tool: string,
  ts: number,
  tmuxPid: number,
  name = '',
): string {
  return JSON.stringify({ state, pane, session, tool, name, ts, tmux_pid: tmuxPid }) + '\n';
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

  const sessionName = (): string => {
    try {
      return pi.getSessionName?.() ?? '';
    } catch {
      return '';
    }
  };

  let lastState = '';
  const write = (state: string, tool: string): void => {
    lastState = state;
    try {
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        statusFile,
        buildPiStatusLine(state, paneId, session, tool, Math.floor(Date.now() / 1000), tmuxPid, sessionName()),
      );
    } catch {
      // Never break the user's pi session over a status write.
    }
  };

  let currentTool = '';
  let running = false;
  let beforePrompt = '';
  /** A dialog is on screen; completion must not overwrite its permit/question. */
  let promptOpen = false;
  /** The run finished while a dialog was open; publish done when it closes. */
  let finishedDuringPrompt = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const heartbeatMs = Number(process.env.FLEET_PI_HEARTBEAT_MS) || 60_000;
  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  // Only re-stamp "working": never overwrite a permit/question/done.
  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (lastState === 'working') write('working', currentTool);
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  // Port of fleet_notify (hooks/lib.sh). Async, and every failure is swallowed.
  const notify = (state: string, tool = ''): void => {
    const msg = fleetNotifyMessage(state, session, tool);
    if (!msg) return;
    const tmux = (args: string[], done?: (out: string) => void) =>
      execFile('tmux', args, { encoding: 'utf8' }, (err, out) => {
        if (!err) done?.(String(out).trim());
      });
    tmux(['display-message', '-p', '#{pane_id}\t#{session_name}'], (out) => {
      const [currentPane, currentSession] = out.split('\t');
      if (currentPane === paneId) return; // the user is looking at this pane
      tmux(['display-message', '-d', '3000', tmuxLiteral(msg)]);
      tmux(['show-option', '-gqv', '@fleet_bell'], (bell) => {
        if (bell === 'on' && currentSession !== session) tmux(['run-shell', '-t', paneId, "printf '\\a'"]);
      });
    });
  };

  // agent_end can precede an automatic retry or a queued follow-up; agent_settled
  // is pi's "finished" boundary. Older pi builds lack agent_settled, so agent_end
  // also schedules done, the way hooks/stop.sh waits before writing done.
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  const doneDelayMs = Number(process.env.FLEET_PI_DONE_DELAY_MS) || 3000;
  const finish = (): void => {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = undefined;
    if (running || lastState === 'done') return;
    if (promptOpen) {
      finishedDuringPrompt = true;
      return;
    }
    currentTool = '';
    write('done', '');
    notify('done');
  };

  pi.on('session_start', () => {
    // tmux env is fully populated by now; backfill anything missing at load.
    if (!session) session = tmuxQuery('#{session_name}');
    if (!tmuxPid) tmuxPid = Number(tmuxQuery('#{pid}')) || 0;
    // Write on start/reload/resume: pi names sessions out-of-band (auto-namer,
    // /name), and an idle session fires no later lifecycle event — without this
    // the name would never reach the status file until the next turn. Discovery
    // already surfaces a fresh pi pane as IDLE, so this changes the label, not
    // the visibility.
    write('idle', '');
  });
  pi.on('agent_start', () => {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = undefined;
    finishedDuringPrompt = false;
    running = true;
    write('working', currentTool);
    startHeartbeat();
  });
  pi.on('turn_start', () => {
    if (running && lastState === 'working') write('working', currentTool);
  });
  pi.on('tool_execution_start', (event) => {
    currentTool = fleetPiLabel(event.toolName, event.args);
    write('working', currentTool);
  });
  // Write a waiting state, notifying only on the way in: a question tool that
  // also opens a dialog must not message twice.
  const wait = (state: 'permit' | 'question', label: string): void => {
    const was = lastState;
    write(state, label);
    if (was !== state) notify(state, label);
  };
  pi.on('tool_call', (event) => {
    // tool_call fires after every extension's tool_execution_start handler, so
    // another status extension cannot overwrite this with its own working write.
    if (isPiQuestionTool(event.toolName)) wait('question', QUESTION_TOOL_LABEL);
  });
  pi.on('tool_execution_end', (event) => {
    if (isPiQuestionTool(event.toolName)) write('working', currentTool);
  });
  pi.events?.on('rpiv:ask-user:blocked', (payload) => {
    if (payload.active) wait('question', QUESTION_TOOL_LABEL);
    else write('working', currentTool);
  });
  pi.on('ui_prompt_start', (event) => {
    promptOpen = true;
    beforePrompt = lastState;
    wait(piPromptState(event.kind), event.title ?? '');
  });
  pi.on('ui_prompt_end', () => {
    promptOpen = false;
    if (!running && finishedDuringPrompt) {
      finishedDuringPrompt = false;
      lastState = ''; // let finish() publish done over the dialog's state
      finish();
      return;
    }
    write(running ? 'working' : beforePrompt || 'idle', running ? currentTool : '');
  });
  pi.on('agent_end', () => {
    running = false;
    stopHeartbeat();
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(finish, doneDelayMs);
    doneTimer.unref?.();
  });
  pi.on('agent_settled', finish);
  // The auto-name lands after the first turn, between lifecycle writes —
  // rewrite the current state so a rename/auto-name shows up immediately
  // instead of whenever the next write happens.
  pi.on('session_info_changed', () => {
    if (lastState) write(lastState, currentTool);
  });
  pi.on('session_shutdown', () => {
    stopHeartbeat();
    if (doneTimer) clearTimeout(doneTimer);
    // pi is exiting — drop the status file so the pane doesn't linger as done.
    lastState = '';
    try {
      rmSync(statusFile, { force: true });
    } catch {
      // ignore
    }
  });
}
