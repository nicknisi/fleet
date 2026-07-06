import { AgentStatus, type DetectResult } from './types.ts';
import { capturePane } from '../tmux/sessions.ts';
import {
  CLAUDE_MANIFEST,
  getCompiledRegex,
  loadDetectionManifest,
  PROMPT_MARKER_RULE_ID,
  type DetectionManifest,
} from './detection.ts';

const SCRAPE_LINES = 50;

// Maps a manifest rule's serialized state onto the AgentStatus the scraper emits.
const RULE_STATE_TO_STATUS = {
  PERMIT: AgentStatus.PERMIT,
  QUESTION: AgentStatus.QUESTION,
  BUSY: AgentStatus.BUSY,
  IDLE: AgentStatus.IDLE,
} as const;

// Data-driven detection: walk the manifest's ordered rules (first match wins)
// over the bottom `linesFromBottom` window, then fall back to the prompt marker.
// Defaults to the built-in claude manifest so the regression tests can call it
// with a single `lines` argument and touch no disk.
export function detectFromPaneContent(lines: string[], manifest: DetectionManifest = CLAUDE_MANIFEST): DetectResult {
  const bottomText = lines.slice(-manifest.linesFromBottom).join('\n');

  for (const rule of manifest.rules) {
    const re = getCompiledRegex(rule);
    if (re && re.test(bottomText)) {
      return { status: RULE_STATE_TO_STATUS[rule.state], ruleId: rule.id };
    }
  }

  // Prompt-marker fallback. NB: this scans the FULL captured buffer, not just
  // the bottom window the rules use — preserved verbatim from the pre-Phase-2
  // scraper (a stale prompt high in scrollback still reads as IDLE). Tightening
  // it to the window would be a behavior change, so it stays.
  if (manifest.promptMarker.length > 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.includes(manifest.promptMarker)) {
        return { status: AgentStatus.IDLE, ruleId: PROMPT_MARKER_RULE_ID };
      }
    }
  }

  return { status: null, ruleId: null };
}

// Capture a pane ONCE and return both its classified status and the raw captured
// lines. A caller that also needs the capture (hook-less discovery's spinner-glyph
// check) reuses these lines instead of capturing the same pane a second time.
// scrapePane is exactly this minus the lines.
export function scrapePaneCapture(paneId: string, agent: string): { status: AgentStatus | null; lines: string[] } {
  let lines: string[];
  try {
    lines = capturePane(paneId, SCRAPE_LINES);
  } catch {
    return { status: null, lines: [] };
  }
  // Phase 3: the agent is real (was hardcoded 'claude'). Resolve its manifest
  // (built-in, or a user override) so each agent's prompts classify against its
  // own rules; an unknown agent degrades to an empty manifest (detects nothing).
  return { status: detectFromPaneContent(lines, loadDetectionManifest(agent)).status, lines };
}

export function scrapePane(paneId: string, agent: string): AgentStatus | null {
  return scrapePaneCapture(paneId, agent).status;
}

export interface ScrapeDetail {
  result: DetectResult;
  snapshot: string[]; // the bottom window the detector evaluated
}

export function scrapePaneDetailed(paneId: string, manifest?: DetectionManifest): ScrapeDetail | null {
  let lines: string[];
  try {
    lines = capturePane(paneId, SCRAPE_LINES);
  } catch {
    return null; // capture-pane failed — explain renders "scrape unavailable"
  }
  const m = manifest ?? loadDetectionManifest('claude');
  return { result: detectFromPaneContent(lines, m), snapshot: lines.slice(-m.linesFromBottom) };
}
