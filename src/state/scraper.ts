import { AgentStatus } from './types.ts';
import { capturePane } from '../tmux/sessions.ts';

const SCRAPE_LINES = 50;

export function scrapePane(paneId: string): AgentStatus | null {
  let lines: string[];
  try {
    lines = capturePane(paneId, SCRAPE_LINES);
  } catch {
    return null;
  }
  return detectFromPaneContent(lines);
}

export function detectFromPaneContent(lines: string[]): AgentStatus | null {
  const bottom = lines.slice(-15);
  const bottomText = bottom.join('\n');

  if (/\[y\/n\]|\[Y\/n\]/i.test(bottomText)) return AgentStatus.PERMIT;
  if (/Do you want to (proceed|allow)/.test(bottomText)) return AgentStatus.PERMIT;
  if (/Enter to select.*[↑↓]|Esc to cancel/.test(bottomText)) return AgentStatus.QUESTION;

  // Claude Code shows a working status line while a turn is in flight. The spinner
  // glyph and verb animate (✻ "Trapping Gollum…" -> ✢ "Sharting…"), so match the
  // stable parts instead: the elapsed/token counter "(1m 11s · ↓ 3.4k tokens)" and
  // the "esc to interrupt" affordance. Either is a definitive BUSY signal.
  if (/\(\d+m\s+\d+s\s+·.*tokens?\)/.test(bottomText)) return AgentStatus.BUSY;
  if (/\(\d+s\s+·.*tokens?\)/.test(bottomText)) return AgentStatus.BUSY;
  if (/esc to interrupt/i.test(bottomText)) return AgentStatus.BUSY;

  let promptLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('❯')) {
      promptLine = i;
      break;
    }
  }

  if (promptLine === -1) return null;

  return AgentStatus.IDLE;
}
