import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { AgentStatus, type EventEntry } from './types.ts';

const TAIL_BYTES = 8192;

export function parseEventLog(content: string): EventEntry[] {
  const entries: EventEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        event: String(data.event ?? ''),
        ts: Number(data.ts ?? 0),
        tool: data.tool != null ? String(data.tool) : undefined,
        stop_reason: data.stop_reason != null ? String(data.stop_reason) : undefined,
        background_tasks: data.background_tasks === true ? true : undefined,
        notification_type: data.notification_type != null ? String(data.notification_type) : undefined,
      });
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

export function readEventLog(path: string): EventEntry[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, 'utf-8');
    return parseEventLog(content);
  } catch {
    return [];
  }
}

export function readLastEvent(path: string): EventEntry | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path, 'utf-8');
    let end = buf.length;
    while (end > 0 && buf[end - 1] === '\n') end--;
    if (end === 0) return null;
    let start = buf.lastIndexOf('\n', end - 1);
    if (start === -1) start = 0;
    else start++;
    const line = buf.slice(start, end);
    if (line.length === 0) return null;
    const data = JSON.parse(line) as Record<string, unknown>;
    return {
      event: String(data.event ?? ''),
      ts: Number(data.ts ?? 0),
      tool: data.tool != null ? String(data.tool) : undefined,
      stop_reason: data.stop_reason != null ? String(data.stop_reason) : undefined,
      background_tasks: data.background_tasks === true ? true : undefined,
      notification_type: data.notification_type != null ? String(data.notification_type) : undefined,
    };
  } catch {
    return null;
  }
}

// Read just the last `maxLines` events without parsing the whole file — reads a
// bounded tail off the end so the hot refresh path stays cheap on long logs.
export function readLastEvents(path: string, maxLines: number): EventEntry[] {
  if (!existsSync(path)) return [];
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const readBytes = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(readBytes);
      readSync(fd, buf, 0, readBytes, size - readBytes);
      const lines = buf
        .toString('utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      // If we didn't reach the start of the file, the first line may be partial.
      const usable = size > readBytes ? lines.slice(1) : lines;
      return parseEventLog(usable.slice(-maxLines).join('\n'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function deriveStatusFromLastEvent(event: EventEntry | null): AgentStatus | null {
  if (!event) return null;
  return deriveStatusFromEvents([event]);
}

export function deriveStatusFromEvents(events: EventEntry[]): AgentStatus | null {
  if (events.length === 0) return null;

  const last = events[events.length - 1]!;

  // Fleet writes this when you switch to a ready agent — you've seen it, so it
  // drops out of the attention tier until the agent does something new.
  if (last.event === 'Acknowledged') return AgentStatus.IDLE;

  if (last.event === 'Stop' || last.event === 'SubagentStop') {
    if (last.background_tasks) return AgentStatus.BUSY;
    if (last.stop_reason === 'tool_use') return AgentStatus.BUSY;
    return AgentStatus.DONE;
  }

  // AskUserQuestion is Claude asking YOU a multiple-choice question, not running
  // a tool on your behalf — that's the asking (QUESTION) state, not working.
  if (last.event === 'PreToolUse') {
    return last.tool === 'AskUserQuestion' ? AgentStatus.QUESTION : AgentStatus.BUSY;
  }

  if (last.event === 'Notification') {
    switch (last.notification_type) {
      case 'permission_prompt':
        // A permission_prompt fires both for tool approvals and for
        // AskUserQuestion. They're indistinguishable from the notification
        // alone, so trace back to the tool that triggered it: AskUserQuestion
        // is a question, anything else is a real permission request.
        return triggeredByAskUserQuestion(events) ? AgentStatus.QUESTION : AgentStatus.PERMIT;
      case 'elicitation_dialog':
        return AgentStatus.QUESTION;
      case 'idle_prompt':
        return AgentStatus.DONE;
    }
  }

  return null;
}

function triggeredByAskUserQuestion(events: EventEntry[]): boolean {
  // Walk back from the notification to the PreToolUse that opened the prompt. A
  // Stop/SubagentStop in between means a turn ended, so the prompt belongs to a
  // later, unrelated request.
  for (let i = events.length - 2; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === 'Stop' || e.event === 'SubagentStop') return false;
    if (e.event === 'PreToolUse') return e.tool === 'AskUserQuestion';
  }
  return false;
}
