import { describe, expect, test } from 'bun:test';
import { parseEventLog, deriveStatusFromEvents } from './events.ts';
import { AgentStatus } from './types.ts';

describe('parseEventLog', () => {
  test('parses JSONL content', () => {
    const content = '{"event":"PreToolUse","ts":1}\n{"event":"Stop","ts":2,"stop_reason":"end_turn"}';
    const events = parseEventLog(content);
    expect(events.length).toBe(2);
    expect(events[0]!.event).toBe('PreToolUse');
    expect(events[1]!.stop_reason).toBe('end_turn');
  });

  test('skips malformed lines', () => {
    const events = parseEventLog('{"event":"PreToolUse","ts":1}\nnot json\n{"event":"Stop","ts":2}');
    expect(events.length).toBe(2);
  });
});

describe('deriveStatusFromEvents', () => {
  test('tool_use stop_reason means BUSY', () => {
    const events = parseEventLog('{"event":"Stop","ts":1,"stop_reason":"tool_use"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.BUSY);
  });

  test('end_turn stop_reason means DONE', () => {
    const events = parseEventLog('{"event":"Stop","ts":1,"stop_reason":"end_turn"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.DONE);
  });

  test('background_tasks suppresses DONE', () => {
    const events = parseEventLog('{"event":"Stop","ts":1,"stop_reason":"end_turn","background_tasks":true}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.BUSY);
  });

  test('PreToolUse means BUSY', () => {
    const events = parseEventLog('{"event":"PreToolUse","ts":1,"tool":"Edit"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.BUSY);
  });

  test('permission_prompt notification means PERMIT', () => {
    const events = parseEventLog('{"event":"Notification","ts":1,"notification_type":"permission_prompt"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.PERMIT);
  });

  test('elicitation_dialog notification means QUESTION', () => {
    const events = parseEventLog('{"event":"Notification","ts":1,"notification_type":"elicitation_dialog"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.QUESTION);
  });

  test('empty events returns null', () => {
    expect(deriveStatusFromEvents([])).toBeNull();
  });
});
