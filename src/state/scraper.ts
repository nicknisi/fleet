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
  if (/Enter to select.*[↑↓]|Esc to cancel.*Tab to amend/.test(bottomText)) return AgentStatus.PERMIT;

  let promptLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('❯')) {
      promptLine = i;
      break;
    }
  }

  if (promptLine === -1) return null;

  const start = Math.max(0, promptLine - 10);
  const above = lines.slice(start, promptLine);
  const aboveText = above.join('\n');

  if (/^[✢✶·⏳⏺●] \S+…|Running…/m.test(aboveText)) {
    return AgentStatus.BUSY;
  }

  return AgentStatus.DONE;
}
