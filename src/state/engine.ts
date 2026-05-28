import { AgentStatus } from './types.ts';

const WORKING_TIMEOUT_SECS = 180;

export interface FuseInput {
  hookState: string;
  hookTs: number;
  eventStatus: AgentStatus | null;
  scrapeStatus: AgentStatus | null;
  currentStatus: AgentStatus;
  currentTs: number;
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

export function fuseState(input: FuseInput): AgentStatus {
  const now = Math.floor(Date.now() / 1000);

  // Freshness invariant: a newer in-memory state beats a staler hook write.
  if (input.hookTs <= input.currentTs && input.currentStatus !== AgentStatus.IDLE) {
    const age = now - input.currentTs;
    // A stuck "working" eventually retires — a crashed turn shouldn't spin
    // forever. But DONE never auto-decays: a finished turn is waiting on you and
    // stays "ready" until you actually act on it (switch to it, send, or it
    // starts working again). Timing out a pending hand-off into "idle" is what
    // made questions silently disappear.
    if (input.currentStatus === AgentStatus.BUSY && age >= WORKING_TIMEOUT_SECS) {
      return AgentStatus.IDLE;
    }
    return input.currentStatus;
  }

  // The scraper reliably reads permission prompts ([y/n], "Do you want to…") and
  // question dialogs ("Enter to select") — fixed on-screen strings the hook layer
  // can't tell apart. Trust those reads absolutely.
  if (input.scrapeStatus === AgentStatus.PERMIT || input.scrapeStatus === AgentStatus.QUESTION) {
    return input.scrapeStatus;
  }

  // Derive the hook/event activity status — the reliable BUSY/DONE signal.
  // PreToolUse fires the instant a tool runs; Stop fires when a turn ends.
  let derived = input.eventStatus ?? mapHookState(input.hookState);
  const hookAge = now - input.hookTs;
  if (derived === AgentStatus.BUSY && hookAge >= WORKING_TIMEOUT_SECS) {
    derived = AgentStatus.IDLE;
  }

  // Scraper BUSY is a positive activity read (running token counter on screen).
  if (input.scrapeStatus === AgentStatus.BUSY) {
    return AgentStatus.BUSY;
  }

  // Scraper IDLE just means the live screen shows a bare prompt with no dialog
  // and no spinner. That looks identical whether the agent just finished (DONE)
  // or has been idle a while (IDLE), and the scraper can miss an animated spinner
  // between frames. So an idle screen can only retire a *stale prompt* — a
  // PERMIT/QUESTION that's since been answered and is gone from the screen. It
  // must never override a derived DONE or BUSY; time decay above retires those.
  if (input.scrapeStatus === AgentStatus.IDLE) {
    if (derived === AgentStatus.PERMIT || derived === AgentStatus.QUESTION) {
      return AgentStatus.IDLE;
    }
    return derived;
  }

  // No scrape result — fall back to the derived hook/event status.
  return derived;
}
