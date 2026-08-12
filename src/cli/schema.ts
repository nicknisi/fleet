// Versioned, machine-readable observability schema (v1). Agent-listing verbs
// (`list --json`, `status --json`, `watch --jsonl`) share this envelope;
// `capture --json` uses a command-specific payload with the same
// schema/outcome/queriedAt/selector base fields. Pure: builders take
// already-resolved AgentState[] and a clock, never touching tmux or disk.

import {
  AgentStatus,
  displayName,
  sessionLabel,
  windowLabel,
  type AgentState,
  type StateDecision,
} from '../state/types.ts';
import type { GitMetadata } from '../state/git-metadata.ts';
import type { WorkmuxEnrichment } from '../adapters/workmux.ts';
import { computeRepoGroups, siblingWorktreeCount } from '../state/repo-groups.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';

export const SCHEMA_VERSION = 'fleet.observe/v1';

// The full set of outcomes the schema can encode. A consumer switches on these
// exhaustively; each is produced by classifyOutcome below.
//   ok                every requested agent resolved cleanly
//   no_agents         tmux answered, but no agents are present at all
//   no_match          a selector was given and matched nothing (agents exist)
//   ambiguous         a selector matched multiple panes where one was required
//   tmux_unavailable  tmux could not be queried and no cached data was available
//   stale_data        tmux is unavailable but a prior snapshot is being reported
//   unknown           a defensive fallback for an unclassifiable result
export type Outcome = 'ok' | 'no_agents' | 'no_match' | 'ambiguous' | 'tmux_unavailable' | 'stale_data' | 'unknown';

// A single agent, flattened for machines. Carries tmux identity (pane/window/
// session), the resolved agent type, the final state, the per-layer state
// candidates + winning source, the matched scrape rule id, and timestamps.
export interface AgentView {
  pane: string; // %42 — tmux pane id
  paneNum: number;
  windowId: string; // @5 — tmux window id
  window: string; // window name (raw)
  windowLabel: string; // window-first display label
  session: string; // tmux session name
  sessionLabel: string; // session:window display label
  label: string; // primary display name (rename > claude name > session)
  agentType: string; // 'claude' | 'codex' | ... | '' for a shell pane
  tracking: 'hook' | 'discovery' | 'shell';
  status: AgentStatus; // fused final state
  needsAttention: boolean;
  // Provenance is null only for shell panes; hooked and discovered agents fuse.
  source: StateDecision['winner'] | null; // winning layer
  candidates: { hook: AgentStatus | null; event: AgentStatus | null; scrape: AgentStatus | null } | null;
  scrapeRuleId: string | null; // matched scraper/title rule id
  reason: string | null; // human-readable why, from the fuser
  workingTimeoutFired: boolean; // stale-BUSY decay flag from the fuser
  // Timestamps (epoch seconds). `ts` is the state's own timestamp; hook/event
  // are the layer inputs the fusion decided on (null when a layer was silent).
  ts: number;
  timestampKind: 'state_change' | 'observed';
  hookTs: number | null;
  eventTs: number | null;
  tool: string | null;
  project: string | null;
  branch: string | null;
  ports: number[];
  // --- Additive (v1) git metadata. null on a non-git dir. -------------------
  git: GitMetadata | null;
  // Distinct sibling worktrees sharing this pane's repository id (0 when the
  // pane has no git metadata). Computed across the reported agent set.
  repoSiblingCount: number;
  // --- Additive (v1) workmux enrichment. null when unmanaged/absent. --------
  workmux: WorkmuxEnrichment | null;
}

export interface Envelope {
  schema: typeof SCHEMA_VERSION;
  outcome: Outcome;
  queriedAt: number; // epoch ms — when the query ran
  selector: string | null; // the selector string, when one was applied
  count: number; // agents.length, for a quick machine check
  agents: AgentView[];
}

// A pane is an "agent" for reporting when it carries an agent identity — hooked
// or discovered. Shell panes (empty agentType) are dropped so a machine sees
// only real agents, mirroring the dashboard's own filtering.
export function isAgent(state: AgentState): boolean {
  return state.agentType.length > 0;
}

export function toAgentView(state: AgentState, repoSiblingCount = 0): AgentView {
  const d = state.decision ?? null;
  return {
    pane: state.paneId,
    paneNum: state.paneNum,
    windowId: state.windowId,
    window: state.window,
    windowLabel: windowLabel(state),
    session: state.session,
    sessionLabel: sessionLabel(state),
    label: displayName(state),
    agentType: state.agentType,
    tracking: state.tracking ?? (state.agentType.length > 0 ? 'hook' : 'shell'),
    status: state.status,
    needsAttention:
      state.status === AgentStatus.PERMIT || state.status === AgentStatus.QUESTION || state.status === AgentStatus.DONE,
    source: d?.winner ?? null,
    candidates: d ? d.candidates : null,
    scrapeRuleId: d?.scrapeRuleId ?? null,
    reason: d?.reason ?? null,
    workingTimeoutFired: d?.workingTimeoutFired ?? false,
    ts: state.ts,
    timestampKind: state.tracking === 'discovery' ? 'observed' : 'state_change',
    hookTs: d ? d.hookTs : null,
    eventTs: d ? d.eventTs : null,
    tool: state.tool,
    project: state.project,
    branch: state.branch,
    ports: state.ports,
    git: state.git ?? null,
    repoSiblingCount,
    workmux: state.workmux ?? null,
  };
}

export interface ClassifyInput {
  tmuxOk: boolean; // getLastTmuxOk() after the refresh
  totalAgents: number; // agent count BEFORE selector filtering
  selectorApplied: boolean; // was a selector supplied?
  matchedAgents: number; // agent count AFTER selector filtering
}

// Single source of truth for outcome precedence, shared by every verb so the
// same world yields the same outcome regardless of which command asked.
export function classifyOutcome(input: ClassifyInput): Outcome {
  if (!input.tmuxOk) return input.totalAgents > 0 ? 'stale_data' : 'tmux_unavailable';
  if (input.selectorApplied && input.matchedAgents === 0) return 'no_match';
  if (input.totalAgents === 0) return 'no_agents';
  return 'ok';
}

// Map an outcome to its process exit code. ok / no_agents / stale_data still
// produced valid JSON, so they exit 0; a selector miss or a dead tmux are
// script-actionable failures with their own codes; unknown is a generic error.
export function outcomeExitCode(outcome: Outcome): ExitCode {
  switch (outcome) {
    case 'ok':
    case 'no_agents':
    case 'stale_data':
      return EXIT.OK;
    case 'no_match':
      return EXIT.NO_MATCH;
    case 'ambiguous':
      return EXIT.AMBIGUOUS;
    case 'tmux_unavailable':
      return EXIT.TMUX_UNAVAILABLE;
    case 'unknown':
      return EXIT.USAGE;
  }
}

export interface BuildEnvelopeInput {
  agents: AgentState[]; // already selector-filtered agents to report
  groupAgents?: AgentState[]; // unfiltered roster used for sibling counts
  outcome: Outcome;
  selector: string | null;
  now: number; // epoch ms
}

export function buildEnvelope(input: BuildEnvelopeInput): Envelope {
  // Sibling counts are computed across the unfiltered roster when supplied, so
  // narrowing status to one pane does not make its sibling count collapse.
  const groups = computeRepoGroups(input.groupAgents ?? input.agents);
  return {
    schema: SCHEMA_VERSION,
    outcome: input.outcome,
    queriedAt: input.now,
    selector: input.selector,
    count: input.agents.length,
    agents: input.agents.map((a) => toAgentView(a, siblingWorktreeCount(a, groups))),
  };
}
