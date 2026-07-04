import { AgentStatus, type StateDecision } from './types.ts';

const WORKING_TIMEOUT_SECS = 180;

export interface FuseInput {
  hookState: string;
  hookTs: number;
  eventStatus: AgentStatus | null;
  eventTs?: number | null; // NEW (optional): last event ts, for the trace only
  scrapeStatus: AgentStatus | null;
  scrapeRuleId?: string | null; // NEW (optional): matched scraper rule, for the trace only
  currentStatus: AgentStatus;
  currentTs: number;
}

export interface FuseResult {
  status: AgentStatus;
  decision: StateDecision;
}

function mapHookState(state: string): AgentStatus {
  switch (state) {
    case 'permit':
      return AgentStatus.PERMIT;
    case 'question':
      return AgentStatus.QUESTION;
    case 'done':
    case 'completed':
      return AgentStatus.DONE;
    case 'working':
      return AgentStatus.BUSY;
    case 'waiting':
      return AgentStatus.PERMIT;
    default:
      return AgentStatus.IDLE;
  }
}

export function fuseState(input: FuseInput): FuseResult {
  const now = Math.floor(Date.now() / 1000);
  const hookCandidate = mapHookState(input.hookState);
  const decision: StateDecision = {
    final: AgentStatus.IDLE,
    candidates: { hook: hookCandidate, event: input.eventStatus, scrape: input.scrapeStatus },
    hookTs: input.hookTs,
    eventTs: input.eventTs ?? null,
    now,
    winner: 'hook',
    reason: '',
    workingTimeoutFired: false,
    freshnessEvaluated: false,
    scrapeRuleId: input.scrapeRuleId ?? null,
  };
  const finish = (status: AgentStatus, winner: StateDecision['winner'], reason: string): FuseResult => {
    decision.final = status;
    decision.winner = winner;
    decision.reason = reason;
    return { status, decision };
  };

  // Freshness invariant: a newer in-memory state beats a staler hook write.
  // DEAD in live — index.ts passes currentTs=0, currentStatus=IDLE, so the second
  // clause is always false and this branch never fires outside engine.test.ts.
  if (input.hookTs <= input.currentTs && input.currentStatus !== AgentStatus.IDLE) {
    decision.freshnessEvaluated = true;
    const age = now - input.currentTs;
    // A stuck "working" eventually retires — a crashed turn shouldn't spin
    // forever. But DONE never auto-decays: a finished turn is waiting on you and
    // stays "ready" until you actually act on it (switch to it, send, or it
    // starts working again). Timing out a pending hand-off into "idle" is what
    // made questions silently disappear.
    if (input.currentStatus === AgentStatus.BUSY && age >= WORKING_TIMEOUT_SECS) {
      decision.workingTimeoutFired = true;
      return finish(AgentStatus.IDLE, 'default', `stale in-memory BUSY aged ${age}s ≥ ${WORKING_TIMEOUT_SECS}s`);
    }
    return finish(
      input.currentStatus,
      'default',
      'freshness invariant: newer in-memory state kept over a staler hook write',
    );
  }

  // The scraper reliably reads permission prompts ([y/n], "Do you want to…") and
  // question dialogs ("Enter to select") — fixed on-screen strings the hook layer
  // can't tell apart. Trust those reads absolutely.
  if (input.scrapeStatus === AgentStatus.PERMIT || input.scrapeStatus === AgentStatus.QUESTION) {
    return finish(
      input.scrapeStatus,
      'scrape',
      'scraper read an on-screen permission/question prompt — trusted absolutely',
    );
  }

  // Derive the hook/event activity status — the reliable BUSY/DONE signal.
  // PreToolUse fires the instant a tool runs; Stop fires when a turn ends.
  let derived = input.eventStatus ?? hookCandidate;
  const fromEvent = input.eventStatus !== null;
  const hookAge = now - input.hookTs;
  if (derived === AgentStatus.BUSY && hookAge >= WORKING_TIMEOUT_SECS) {
    derived = AgentStatus.IDLE;
    decision.workingTimeoutFired = true;
  }

  // Scraper BUSY is a positive activity read (running token counter on screen).
  if (input.scrapeStatus === AgentStatus.BUSY) {
    return finish(AgentStatus.BUSY, 'scrape', 'scraper saw a live token counter / esc-to-interrupt');
  }

  // Scraper IDLE just means the live screen shows a bare prompt with no dialog
  // and no spinner. That looks identical whether the agent just finished (DONE)
  // or has been idle a while (IDLE), and the scraper can miss an animated spinner
  // between frames. So an idle screen can only retire a *stale prompt* — a
  // PERMIT/QUESTION that's since been answered and is gone from the screen. It
  // must never override a derived DONE or BUSY; time decay above retires those.
  if (input.scrapeStatus === AgentStatus.IDLE && (derived === AgentStatus.PERMIT || derived === AgentStatus.QUESTION)) {
    return finish(AgentStatus.IDLE, 'scrape', 'screen shows a bare prompt — a stale permit/question was cleared');
  }

  // Derived hook/event status wins (scrape IDLE never demotes a derived DONE/BUSY;
  // scrape null falls here too).
  const winner: StateDecision['winner'] = decision.workingTimeoutFired ? 'default' : fromEvent ? 'event' : 'hook';
  const reason = decision.workingTimeoutFired
    ? `hook BUSY aged ${hookAge}s ≥ ${WORKING_TIMEOUT_SECS}s — decayed to idle`
    : fromEvent
      ? 'derived from the latest JSONL event'
      : 'derived from the hook status file';
  return finish(derived, winner, reason);
}
