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
    case 'waiting':
      return AgentStatus.PERMIT;
    case 'working':
      return AgentStatus.BUSY;
    case 'completed':
      return AgentStatus.DONE;
    default:
      return AgentStatus.IDLE;
  }
}

export function fuseState(input: FuseInput): AgentStatus {
  const now = Math.floor(Date.now() / 1000);

  // Freshness invariant: reject stale hook data
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

  // Scrape layer is the visual arbiter — PERMIT from scrape always wins
  if (input.scrapeStatus === AgentStatus.PERMIT) {
    return AgentStatus.PERMIT;
  }

  // Event layer is more specific than hook layer
  if (input.eventStatus !== null) {
    return input.eventStatus;
  }

  // Map hook state
  let status = mapHookState(input.hookState);

  // Apply decay
  const hookAge = now - input.hookTs;
  if (status === AgentStatus.DONE && hookAge >= DONE_DECAY_SECS) {
    status = AgentStatus.IDLE;
  }
  if (status === AgentStatus.BUSY && hookAge >= WORKING_TIMEOUT_SECS) {
    status = AgentStatus.IDLE;
  }

  return status;
}
