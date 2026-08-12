// `fleet watch [selector...] --jsonl` — a read-only change stream. Emits one
// initial snapshot line, then one line per state change, forever, until torn
// down (SIGINT in prod, a stop predicate under test). It never writes status
// files or acknowledges anything — it only reads and reports.
//
// Wire format is JSON Lines (one object per line):
//   {schema, type:"snapshot", queriedAt, outcome, selector, count, agents:[...]}
//   {schema, type:"change",   queriedAt, pane, session, agentType, from, to, agent:{...}}
//
// The change stream is debounced by the poll interval itself: each tick diffs
// the fresh states against the last emitted status per pane, so a pane only
// emits when its status actually changes (bursts within one interval collapse
// to the net change), and appearances/disappearances are reported too.

import { type AgentState } from '../state/types.ts';
import { resolveSelector } from '../state/selector.ts';
import { computeRepoGroups, siblingWorktreeCount } from '../state/repo-groups.ts';
import { SCHEMA_VERSION, buildEnvelope, classifyOutcome, isAgent, toAgentView, type AgentView } from './schema.ts';

export const WATCH_INTERVAL_MS = 500;

export interface ChangeLine {
  schema: typeof SCHEMA_VERSION;
  type: 'change';
  queriedAt: number;
  pane: string;
  session: string;
  agentType: string;
  from: string | null; // previous status, or null when the agent just appeared
  to: string | null; // new status, or null when the agent disappeared
  agent: AgentView | null; // full view of the agent now, null on disappearance
}

// Filter states down to the agents this watch cares about: with no selectors,
// every agent; otherwise the union of the selectors' matches (agents only).
export function selectAgents(states: AgentState[], selectors: string[]): AgentState[] {
  const agents = states.filter(isAgent);
  if (selectors.length === 0) return agents;
  const seen = new Set<string>();
  const out: AgentState[] = [];
  for (const sel of selectors) {
    for (const m of resolveSelector(sel, agents).matches) {
      if (!seen.has(m.paneId)) {
        seen.add(m.paneId);
        out.push(m);
      }
    }
  }
  return out;
}

// Pure diff: compare the previous per-pane status map to the current agents and
// return one change line per pane whose status changed, appeared, or vanished.
// Returns the change lines plus the next status map to carry forward.
export function diffStates(
  prev: Map<string, string>,
  agents: AgentState[],
  now: number,
): { changes: ChangeLine[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changes: ChangeLine[] = [];
  const byPane = new Map<string, AgentState>();
  const groups = computeRepoGroups(agents);
  for (const a of agents) byPane.set(a.paneId, a);

  for (const a of agents) {
    next.set(a.paneId, a.status);
    const before = prev.get(a.paneId);
    if (before !== a.status) {
      changes.push({
        schema: SCHEMA_VERSION,
        type: 'change',
        queriedAt: now,
        pane: a.paneId,
        session: a.session,
        agentType: a.agentType,
        from: before ?? null,
        to: a.status,
        agent: toAgentView(a, siblingWorktreeCount(a, groups)),
      });
    }
  }

  // Disappearances: a pane in prev but absent now.
  for (const [pane, status] of prev) {
    if (!byPane.has(pane)) {
      changes.push({
        schema: SCHEMA_VERSION,
        type: 'change',
        queriedAt: now,
        pane,
        session: '',
        agentType: '',
        from: status,
        to: null,
        agent: null,
      });
    }
  }

  return { changes, next };
}

export interface RunWatchOptions {
  selectors: string[];
  getStates: () => AgentState[]; // prod: () => fullRefreshStates(dirs)
  tmuxOk: () => boolean; // prod: () => getLastTmuxOk()
  emit: (line: string) => void; // prod: (l) => process.stdout.write(l + '\n')
  sleep: (ms: number) => Promise<void>;
  now: () => number; // epoch ms
  stop: () => boolean; // becomes true on SIGINT (prod) / after N ticks (test)
  intervalMs?: number;
}

// The initial snapshot line: the same envelope `status --json` would emit,
// tagged type:"snapshot" so a reader can tell the baseline from the changes.
export function snapshotLine(
  agents: AgentState[],
  selectors: string[],
  tmuxOk: boolean,
  now: number,
  totalAgents = agents.length,
  groupAgents = agents,
): string {
  const outcome = classifyOutcome({
    tmuxOk,
    totalAgents,
    selectorApplied: selectors.length > 0,
    matchedAgents: agents.length,
  });
  const envelope = buildEnvelope({
    agents,
    groupAgents,
    outcome,
    selector: selectors.length > 0 ? selectors.join(',') : null,
    now,
  });
  return JSON.stringify({ ...envelope, type: 'snapshot' });
}

export async function runWatch(opts: RunWatchOptions): Promise<number> {
  const interval = opts.intervalMs ?? WATCH_INTERVAL_MS;

  const initialStates = opts.getStates();
  const initialAgents = initialStates.filter(isAgent);
  const initial = selectAgents(initialStates, opts.selectors);
  let tmuxWasOk = opts.tmuxOk();
  opts.emit(snapshotLine(initial, opts.selectors, tmuxWasOk, opts.now(), initialAgents.length, initialAgents));

  let prev = new Map<string, string>();
  for (const a of initial) prev.set(a.paneId, a.status);

  while (!opts.stop()) {
    await opts.sleep(interval);
    if (opts.stop()) break;
    const states = opts.getStates();
    const agents = selectAgents(states, opts.selectors);
    const tmuxOk = opts.tmuxOk();

    // A transient tmux failure is uncertainty, not proof every pane vanished.
    // Emit one degraded snapshot on the transition and retain `prev`, avoiding
    // a false disappearance/reappearance storm. Recovery emits a new baseline.
    if (!tmuxOk) {
      if (tmuxWasOk) {
        const allAgents = states.filter(isAgent);
        opts.emit(snapshotLine(agents, opts.selectors, false, opts.now(), allAgents.length, allAgents));
      }
      tmuxWasOk = false;
      continue;
    }
    if (!tmuxWasOk) {
      const allAgents = states.filter(isAgent);
      opts.emit(snapshotLine(agents, opts.selectors, true, opts.now(), allAgents.length, allAgents));
      prev = new Map(agents.map((agent) => [agent.paneId, agent.status]));
      tmuxWasOk = true;
      continue;
    }

    const { changes, next } = diffStates(prev, agents, opts.now());
    for (const change of changes) opts.emit(JSON.stringify(change));
    prev = next;
  }

  return 0;
}
