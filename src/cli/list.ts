import { compareStatus, displayName, STATUS_DISPLAY, sessionLabel, type AgentState } from '../state/types.ts';
import { EXIT } from './exit-codes.ts';
import { buildEnvelope, classifyOutcome, isAgent, outcomeExitCode, type Outcome } from './schema.ts';

export interface RunListResult {
  stdout: string;
  code: number;
}

// Human-readable roster: one line per agent, most-urgent first, columns padded
// so the state label and location align. Mirrors the dashboard's ordering and
// icons without the interactive chrome.
function renderHuman(agents: AgentState[], outcome: Outcome): string {
  if (agents.length === 0) {
    return outcome === 'tmux_unavailable' ? 'tmux unavailable' : 'No agents found';
  }
  const sorted = [...agents].sort((a, b) => compareStatus(a.status, b.status));
  const lines: string[] = [];
  for (const s of sorted) {
    const d = STATUS_DISPLAY[s.status];
    lines.push(`${d.icon} ${d.label.padEnd(8)} ${s.paneId.padEnd(6)} ${displayName(s).padEnd(24)} ${sessionLabel(s)}`);
  }
  return lines.join('\n');
}

// `fleet list [--json]` — the full agent roster. Pure: the router supplies the
// already-refreshed states, whether tmux answered, and the clock.
export function runList(args: string[], states: AgentState[], tmuxOk: boolean, now: number): RunListResult {
  const json = args.includes('--json');
  const agents = states.filter(isAgent);

  const outcome = classifyOutcome({
    tmuxOk,
    totalAgents: agents.length,
    selectorApplied: false,
    matchedAgents: agents.length,
  });

  if (json) {
    const envelope = buildEnvelope({ agents, outcome, selector: null, now });
    return { stdout: JSON.stringify(envelope), code: outcomeExitCode(outcome) };
  }

  // Human path never fails on an empty/there's-nothing world — it prints a
  // friendly line and exits 0, matching the rest of the human surface.
  return { stdout: renderHuman(agents, outcome), code: EXIT.OK };
}
