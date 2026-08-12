import { C } from '../terminal/colors.ts';
import { stripAnsi } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, formatAgeDelta, sessionLabel, type AgentState } from '../state/types.ts';

// Read-only provenance overlay ("why is this agent in this state?"). It renders
// the StateDecision ALREADY ATTACHED to the AgentState by refreshStates — the
// exact same object `fleet explain` traces and the JSON observers expose — so
// the TUI and the machine-readable output can never disagree. It performs NO
// live re-scrape: a `d` press is a pure read of what the last refresh decided.

function enumOrNone(s: AgentStatus | null): string {
  return s ?? 'none';
}

function safeText(value: unknown, maxLength = 240): string {
  const clean = Array.from(stripAnsi(String(value ?? '')), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('');
  return clean.slice(0, maxLength);
}

// Age relative to the decision's own captured `now`, so the overlay is
// deterministic against a fixture and matches what explain would print.
function ageFrom(now: number, ts: number | null): string {
  if (ts === null || ts === 0) return '—';
  return formatAgeDelta(now - ts);
}

export function renderDecision(state: AgentState): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${C.bold}  Fleet — State Provenance${C.reset}`);
  lines.push('');
  lines.push(
    `  ${C.gray}session${C.reset}   ${safeText(sessionLabel(state))}  ${C.gray}(pane ${safeText(state.paneId)})${C.reset}`,
  );
  lines.push(`  ${C.gray}agent${C.reset}     ${state.agentType.length > 0 ? safeText(state.agentType) : '—'}`);
  lines.push(`  ${C.gray}tracking${C.reset}  ${safeText(state.tracking ?? 'shell')}`);

  const display = STATUS_DISPLAY[state.status];
  lines.push('');
  lines.push(`  ${C.gray}final${C.reset}     ${display.icon} ${display.label} ${C.gray}(${state.status})${C.reset}`);

  const d = state.decision;
  if (!d) {
    lines.push('');
    lines.push(
      state.agentType.length > 0
        ? `  ${C.gray}discovered agent (no hook) — no fusion decision was recorded${C.reset}`
        : `  ${C.gray}shell (no agent hook) — nothing to fuse${C.reset}`,
    );
    lines.push('');
    lines.push(`  ${C.gray}Press any key to close${C.reset}`);
    return lines;
  }

  // Candidate table — the mapped enum, age, and detail for each fused layer.
  lines.push('');
  lines.push(`  ${C.bold}candidates${C.reset}`);
  lines.push(`  ${'source'.padEnd(9)}${'status'.padEnd(9)}${'age'.padEnd(7)}detail`);
  lines.push(
    `  ${'hook'.padEnd(9)}${enumOrNone(d.candidates.hook).padEnd(9)}${ageFrom(d.now, d.hookTs).padEnd(7)}`.trimEnd(),
  );
  lines.push(
    `  ${'event'.padEnd(9)}${enumOrNone(d.candidates.event).padEnd(9)}${ageFrom(d.now, d.eventTs).padEnd(7)}`.trimEnd(),
  );
  const scrapeDetail = d.candidates.scrape !== null ? `rule: ${safeText(d.scrapeRuleId ?? '—')}` : '';
  lines.push(
    `  ${'scrape'.padEnd(9)}${enumOrNone(d.candidates.scrape).padEnd(9)}${''.padEnd(7)}${scrapeDetail}`.trimEnd(),
  );

  lines.push('');
  lines.push(`  ${C.bold}decision${C.reset}`);
  lines.push(`  ${'winner'.padEnd(11)}${safeText(d.winner)}`);
  lines.push(`  ${'reason'.padEnd(11)}${safeText(d.reason)}`);
  lines.push(`  ${'rule id'.padEnd(11)}${safeText(d.scrapeRuleId ?? '—')}`);
  lines.push(`  ${'timeout'.padEnd(11)}${d.workingTimeoutFired ? 'fired (stale BUSY → idle)' : 'not fired'}`);

  lines.push('');
  lines.push(`  ${C.gray}decision timestamps${C.reset}`);
  lines.push(`  ${'now'.padEnd(11)}${d.now}`);
  lines.push(`  ${'hook ts'.padEnd(11)}${d.hookTs === 0 ? '—' : d.hookTs}`);
  lines.push(`  ${'event ts'.padEnd(11)}${d.eventTs ?? '—'}`);

  lines.push('');
  lines.push(`  ${C.gray}Press any key to close${C.reset}`);
  return lines;
}
