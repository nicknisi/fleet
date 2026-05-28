import { AgentStatus } from './types.ts';

const DONE_DECAY_SECS = 60;
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
    if (input.currentStatus === AgentStatus.DONE && age >= DONE_DECAY_SECS) {
      return AgentStatus.IDLE;
    }
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
  if (derived === AgentStatus.DONE && hookAge >= DONE_DECAY_SECS) {
    derived = AgentStatus.IDLE;
  }
  if (derived === AgentStatus.BUSY && hookAge >= WORKING_TIMEOUT_SECS) {
    derived = AgentStatus.IDLE;
  }

  // Scraper BUSY is a positive activity read (running token counter on screen).
  if (input.scrapeStatus === AgentStatus.BUSY) {
    return AgentStatus.BUSY;
  }

  // Scraper IDLE means the live screen shows an idle prompt. Use it to clear a
  // stale PERMIT/DONE, but never to override a live BUSY — the scraper can miss
  // an animated spinner between frames; the working-timeout decay above is what
  // retires genuinely-stuck working states.
  if (input.scrapeStatus === AgentStatus.IDLE) {
    return derived === AgentStatus.BUSY ? AgentStatus.BUSY : AgentStatus.IDLE;
  }

  // No scrape result — fall back to the derived hook/event status.
  return derived;
}
