import { AgentStatus, compareStatus, type AgentState } from '../state/types.ts';
import { canSendTo } from '../tui/send.ts';
import { sendKeys } from '../tmux/send.ts';

export function runSend(session: string, prompt: string, states: AgentState[], force: boolean): number {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) {
    process.stderr.write(`No agents found in session '${session}'\n`);
    return 1;
  }

  // Target the session's AGENT, never a bare shell — typing a prompt into a
  // shell pane and pressing Enter would execute it as a shell command. Among
  // agents, prefer the most urgent (tmux pane order is arbitrary).
  const agents = sessionStates
    .filter((s) => s.status !== AgentStatus.SHELL && s.status !== AgentStatus.DOWN)
    .sort((a, b) => compareStatus(a.status, b.status));
  const target = agents[0];
  if (!target) {
    process.stderr.write(`No agent panes in session '${session}' (only shells)\n`);
    return 1;
  }

  // Same gating policy as the TUI's send mode; --force overrides BUSY only.
  const check = canSendTo(target);
  if (!check.ok && !(force && target.status === AgentStatus.BUSY)) {
    const hint = target.status === AgentStatus.BUSY ? ' — use --force to override' : '';
    process.stderr.write(`Session '${session}': ${check.reason}${hint}\n`);
    return 1;
  }

  try {
    sendKeys(target.paneId, prompt);
    return 0;
  } catch (err) {
    process.stderr.write(`Failed to send: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
