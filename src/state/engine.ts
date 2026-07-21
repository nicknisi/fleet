import { AgentStatus, type StateDecision } from './types.ts';

const WORKING_TIMEOUT_SECS = 180;

export interface FuseInput {
  hookState: string;
  hookTs: number;
  eventStatus: AgentStatus | null;
  eventTs?: number | null; // last event ts — anchors BUSY decay and the trace
  scrapeStatus: AgentStatus | null;
  scrapeRuleId?: string | null; // matched scraper rule, for the trace only
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

// Inverse of mapHookState for the write path (verifyPaneState persists a
// scraped correction as a hook state). Kept next to its twin so the wire
// vocabulary can't drift between the read and write sides.
export function hookStateForStatus(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.PERMIT:
      return 'permit';
    case AgentStatus.QUESTION:
      return 'question';
    case AgentStatus.DONE:
      return 'done';
    case AgentStatus.BUSY:
      return 'working';
    default:
      return 'idle';
  }
}

// Status for a hook-less discovered agent — the same fusion as the hook path
// with the hook layer silenced. The scraper's positive reads (an on-screen
// permission prompt, question dialog, or live token counter) outrank the
// spinner-glyph heuristic; the glyph stands in as the activity (BUSY) signal
// when the scraper sees nothing; a scraped bare prompt never demotes a live
// glyph (the discovery debounce owns that decay).
export function fuseDiscoveredState(working: boolean, scrapeStatus: AgentStatus | null, now: number): AgentStatus {
  return fuseState({
    hookState: 'idle',
    hookTs: now, // anchors the BUSY decay window at "fresh" so it can't fire here
    eventStatus: working ? AgentStatus.BUSY : null,
    scrapeStatus,
  }).status;
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
    scrapeRuleId: input.scrapeRuleId ?? null,
  };
  const finish = (status: AgentStatus, winner: StateDecision['winner'], reason: string): FuseResult => {
    decision.final = status;
    decision.winner = winner;
    decision.reason = reason;
    return { status, decision };
  };

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
  // Decay anchors to the freshest activity signal (hook write OR event), so a
  // fresh event-derived BUSY can't be retired by a stale hook ts.
  let derived = input.eventStatus ?? hookCandidate;
  const fromEvent = input.eventStatus !== null;
  const activityAge = now - Math.max(input.hookTs, input.eventTs ?? 0);
  if (derived === AgentStatus.BUSY && activityAge >= WORKING_TIMEOUT_SECS) {
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
    ? `BUSY aged ${activityAge}s ≥ ${WORKING_TIMEOUT_SECS}s — decayed to idle`
    : fromEvent
      ? 'derived from the latest JSONL event'
      : 'derived from the hook status file';
  return finish(derived, winner, reason);
}
