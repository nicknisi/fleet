import { AgentStatus, type DetectResult } from './types.ts';
import { capturePane } from '../tmux/sessions.ts';

const SCRAPE_LINES = 50;
const BOTTOM_LINES = 15; // the window detectFromPaneContent evaluates

export function detectFromPaneContent(lines: string[]): DetectResult {
  const bottom = lines.slice(-BOTTOM_LINES);
  const bottomText = bottom.join('\n');

  if (/\[y\/n\]|\[Y\/n\]/i.test(bottomText)) return { status: AgentStatus.PERMIT, ruleId: 'permit.yn' };
  if (/Do you want to (proceed|allow)/.test(bottomText))
    return { status: AgentStatus.PERMIT, ruleId: 'permit.do-you-want' };
  if (/Enter to select.*[↑↓]|Esc to cancel/.test(bottomText))
    return { status: AgentStatus.QUESTION, ruleId: 'question.enter-select' };

  // Claude Code shows a working status line while a turn is in flight. The spinner
  // glyph and verb animate (✻ "Trapping Gollum…" -> ✢ "Sharting…"), so match the
  // stable parts instead: the elapsed/token counter "(1m 11s · ↓ 3.4k tokens)" and
  // the "esc to interrupt" affordance. Either is a definitive BUSY signal.
  if (/\(\d+m\s+\d+s\s+·.*tokens?\)/.test(bottomText))
    return { status: AgentStatus.BUSY, ruleId: 'busy.token-counter-min' };
  if (/\(\d+s\s+·.*tokens?\)/.test(bottomText)) return { status: AgentStatus.BUSY, ruleId: 'busy.token-counter-sec' };
  if (/esc to interrupt/i.test(bottomText)) return { status: AgentStatus.BUSY, ruleId: 'busy.esc-interrupt' };

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('❯')) return { status: AgentStatus.IDLE, ruleId: 'idle.prompt' };
  }
  return { status: null, ruleId: null };
}

export function scrapePane(paneId: string): AgentStatus | null {
  try {
    return detectFromPaneContent(capturePane(paneId, SCRAPE_LINES)).status;
  } catch {
    return null;
  }
}

export interface ScrapeDetail {
  result: DetectResult;
  snapshot: string[]; // the bottom window the detector evaluated
}

export function scrapePaneDetailed(paneId: string): ScrapeDetail | null {
  let lines: string[];
  try {
    lines = capturePane(paneId, SCRAPE_LINES);
  } catch {
    return null; // capture-pane failed — explain renders "scrape unavailable"
  }
  return { result: detectFromPaneContent(lines), snapshot: lines.slice(-BOTTOM_LINES) };
}
