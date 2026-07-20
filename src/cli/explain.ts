import {
  AgentStatus,
  STATUS_DISPLAY,
  type AgentState,
  type HookStatus,
  type EventEntry,
  type StateDecision,
} from '../state/types.ts';
import { fuseState } from '../state/engine.ts';
import { loadDetectionManifest } from '../state/detection.ts';
import { scrapePaneDetailed, type ScrapeDetail } from '../state/scraper.ts';
import { parseStatusFile } from '../state/hooks.ts';
import { readLastEvents, deriveStatusFromEvents } from '../state/events.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ExplainBlock {
  session: string;
  paneId: string;
  agentType: string;
  statusFile: string | null; // resolved hook file, or null if hookless
  finalStatus: AgentStatus;
  decision: StateDecision | null; // null for a hookless/shell pane
  snapshot: string[] | null; // set only with --show-snapshot; null if capture failed
  scrapeAvailable: boolean;
}

const FRAME_WIDTH = 58;

// Age of a delta in seconds. Pure (takes a delta, not a ts) so renderExplain
// stays deterministic under test — it reads decision.now, never Date.now().
function fmtAge(deltaSecs: number): string {
  const d = Math.max(0, deltaSecs);
  if (d < 5) return 'now';
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

function candidateRow(label: string, status: string, age: string, detail: string): string {
  return `    ${label.padEnd(10)}${status.padEnd(9)}${age.padEnd(8)}${detail}`.trimEnd();
}

function renderSnapshot(block: ExplainBlock): string[] {
  const header = `  snapshot — bottom lines the scraper evaluated (pane ${block.paneId})`;
  if (!block.scrapeAvailable || block.snapshot === null) {
    return [header, '  scrape unavailable (capture-pane failed)'];
  }
  const border = '─'.repeat(FRAME_WIDTH);
  const lines = [header, `  ┌${border}`];
  for (const line of block.snapshot) lines.push(`  │ ${line}`);
  lines.push(`  └${border}`);
  return lines;
}

export function renderExplain(block: ExplainBlock, showSnapshot: boolean): string {
  const display = STATUS_DISPLAY[block.finalStatus];
  const lines: string[] = [
    `fleet explain — session '${block.session}'  (pane ${block.paneId}, ${block.agentType})`,
    '',
    `  final   ${display.icon} ${display.label} (${block.finalStatus})`,
    '',
  ];

  // A hookless pane has no fusion decision to trace. It may still be a
  // DISCOVERED agent (process scan) whose state comes from scrape/title/glyph —
  // distinguish that from a plain shell so the trace isn't misleading.
  if (block.decision === null) {
    lines.push(
      block.agentType.length > 0
        ? `  discovered agent (no hook) — state read from scrape/title/spinner, not fused`
        : '  shell (no agent hook) — nothing to fuse',
    );
    if (showSnapshot) {
      lines.push('');
      lines.push(...renderSnapshot(block));
    }
    return lines.join('\n');
  }

  const d = block.decision;
  const enumOrNone = (s: AgentStatus | null): string => s ?? 'none';

  // Candidate table — the mapped enum for each layer so all three are comparable.
  lines.push('  ' + 'candidates'.padEnd(12) + 'status'.padEnd(9) + 'age'.padEnd(8) + 'detail');

  const hookAge = fmtAge(d.now - d.hookTs);
  lines.push(candidateRow('hook', enumOrNone(d.candidates.hook), hookAge, block.statusFile ?? ''));

  const eventAge = d.eventTs !== null ? fmtAge(d.now - d.eventTs) : '—';
  lines.push(candidateRow('event', enumOrNone(d.candidates.event), eventAge, ''));

  // The scraper is re-read live at explain time, so its age is always "now". It
  // structurally cannot emit DONE (a finished and a long-idle turn both show a
  // bare prompt) — annotate so the trace can't be misread.
  let scrapeStatus: string;
  let scrapeDetail: string;
  if (!block.scrapeAvailable) {
    scrapeStatus = 'unavailable';
    scrapeDetail = '';
  } else if (d.candidates.scrape === null) {
    scrapeStatus = 'none';
    scrapeDetail = 'no rule matched  (DONE never comes from scrape)';
  } else {
    scrapeStatus = d.candidates.scrape;
    scrapeDetail = `rule: ${d.scrapeRuleId ?? '—'}  (DONE never comes from scrape)`;
  }
  lines.push(candidateRow('scrape', scrapeStatus, block.scrapeAvailable ? 'now' : '—', scrapeDetail));

  lines.push('');
  lines.push('  decision');
  lines.push(`    winner            ${d.winner}`);
  lines.push(`    reason            ${d.reason}`);
  lines.push(`    working-timeout   ${d.workingTimeoutFired ? 'fired (stale BUSY → idle)' : 'not fired'}`);
  lines.push(
    `    freshness         ${d.freshnessEvaluated ? 'evaluated — kept in-memory state' : 'not evaluated (live refresh is stateless)'}`,
  );

  if (showSnapshot) {
    lines.push('');
    lines.push(...renderSnapshot(block));
  } else {
    lines.push('');
    lines.push('  run with --show-snapshot to print the scraped buffer');
  }

  return lines.join('\n');
}

// Scan statusDirs for the pane's .status file exactly as acknowledgePane does,
// returning the parsed hook plus its resolved path (for the trace's source column).
function findHook(paneId: string, statusDirs: string[]): { status: HookStatus; file: string } | null {
  const paneNum = paneId.replace('%', '');
  for (const dir of statusDirs) {
    const file = join(dir, `${paneNum}.status`);
    if (!existsSync(file)) continue;
    try {
      const status = parseStatusFile(readFileSync(file, 'utf-8'));
      if (status && status.pane === paneId) return { status, file };
    } catch {
      // Unreadable — try the next dir
    }
  }
  return null;
}

// Last 12 events for the pane, mirroring refreshStates' scan of statusDirs.
function readRecentEvents(paneId: string, statusDirs: string[]): EventEntry[] {
  const paneNum = paneId.replace('%', '');
  for (const dir of statusDirs) {
    const recent = readLastEvents(join(dir, `${paneNum}.events.jsonl`), 12);
    if (recent.length > 0) return recent;
  }
  return [];
}

function toBlock(
  state: AgentState,
  hookFile: string,
  finalStatus: AgentStatus,
  decision: StateDecision,
  detail: ScrapeDetail | null,
  showSnapshot: boolean,
): ExplainBlock {
  return {
    session: state.session,
    paneId: state.paneId,
    agentType: state.agentType,
    statusFile: hookFile,
    finalStatus,
    decision,
    snapshot: showSnapshot ? (detail?.snapshot ?? null) : null,
    scrapeAvailable: detail !== null,
  };
}

function shellBlock(state: AgentState, detail: ScrapeDetail | null, showSnapshot: boolean): ExplainBlock {
  return {
    session: state.session,
    paneId: state.paneId,
    agentType: state.agentType,
    statusFile: null,
    finalStatus: state.status,
    decision: null,
    snapshot: showSnapshot ? (detail?.snapshot ?? null) : null,
    scrapeAvailable: detail !== null,
  };
}

export function runExplain(session: string, states: AgentState[], statusDirs: string[], showSnapshot: boolean): number {
  const targets = states.filter((s) => s.session === session);
  if (targets.length === 0) {
    process.stderr.write(`No agents found in session '${session}'\n`);
    return 1;
  }

  const out: string[] = [];
  for (const state of targets) {
    // Re-scrape live so the ruleId and snapshot reflect the screen right now,
    // not the cache the dashboard warmed on its last slow tick — and with the
    // pane's OWN agent manifest, so a discovered (hook-less) agent's trace shows
    // the rules that actually classify it, not claude's.
    const detail = scrapePaneDetailed(state.paneId, loadDetectionManifest(state.agentType || 'claude'));
    const hook = findHook(state.paneId, statusDirs);
    if (!hook) {
      out.push(renderExplain(shellBlock(state, detail, showSnapshot), showSnapshot));
      continue;
    }
    const events = readRecentEvents(state.paneId, statusDirs);
    const eventStatus = events.length > 0 ? deriveStatusFromEvents(events) : null;
    const { status, decision } = fuseState({
      hookState: hook.status.state,
      hookTs: hook.status.ts,
      eventStatus,
      eventTs: events.at(-1)?.ts ?? null,
      scrapeStatus: detail?.result.status ?? null,
      scrapeRuleId: detail?.result.ruleId ?? null,
      currentStatus: AgentStatus.IDLE, // mirror the live wiring exactly (index.ts:282-283)
      currentTs: 0,
    });
    out.push(renderExplain(toBlock(state, hook.file, status, decision, detail, showSnapshot), showSnapshot));
  }
  process.stdout.write(out.join('\n\n') + '\n');
  return 0;
}
