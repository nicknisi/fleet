import { existsSync, readFileSync } from 'node:fs';
import { AgentStatus, type EventEntry } from './types.ts';

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
    if (start === -1) start = 0; else start++;
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

export function deriveStatusFromLastEvent(event: EventEntry | null): AgentStatus | null {
  if (!event) return null;
  return deriveStatusFromEvents([event]);
}

export function deriveStatusFromEvents(events: EventEntry[]): AgentStatus | null {
  if (events.length === 0) return null;

  const last = events[events.length - 1]!;

  if (last.event === 'Stop' || last.event === 'SubagentStop') {
    if (last.background_tasks) return AgentStatus.BUSY;
    if (last.stop_reason === 'tool_use') return AgentStatus.BUSY;
    return AgentStatus.DONE;
  }

  if (last.event === 'PreToolUse') return AgentStatus.BUSY;

  if (last.event === 'Notification') {
    switch (last.notification_type) {
      case 'permission_prompt': return AgentStatus.PERMIT;
      case 'elicitation_dialog': return AgentStatus.QUESTION;
      case 'idle_prompt': return AgentStatus.DONE;
    }
  }

  return null;
}
