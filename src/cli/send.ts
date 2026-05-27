import { AgentStatus, type AgentState } from '../state/types.ts';
import { sendKeys } from '../tmux/send.ts';

export function runSend(session: string, prompt: string, states: AgentState[], force: boolean): number {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) {
    process.stderr.write(`No agents found in session '${session}'\n`);
    return 1;
  }

  const target = sessionStates[0]!;

  switch (target.status) {
    case AgentStatus.PERMIT:
      process.stderr.write(`Session '${session}' has a permission prompt — refusing to send\n`);
      return 1;
    case AgentStatus.QUESTION:
      process.stderr.write(`Session '${session}' is asking a question — refusing to send\n`);
      return 1;
    case AgentStatus.BUSY:
      if (!force) {
        process.stderr.write(`Session '${session}' is busy — use --force to override\n`);
        return 1;
      }
      break;
    case AgentStatus.DONE:
    case AgentStatus.IDLE:
    case AgentStatus.SHELL:
      break;
    case AgentStatus.DOWN:
      process.stderr.write(`Session '${session}' has no live process\n`);
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
