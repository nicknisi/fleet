import { getCompiledRegex, loadDetectionManifest, type DetectionManifest } from './detection.ts';
import { capturePaneLines, detectFromPaneContent } from './scraper.ts';
import { AgentStatus } from './types.ts';
import { stripAnsi } from '../terminal/ansi.ts';

export type PermitAction = 'approve' | 'deny';

// The literal y/n the TUI sent before answer keys were agent-aware. Kept as the
// last resort so unknown agents and user overrides without key specs behave
// exactly as before: correct for genuine [y/n] prompts, a no-op for menu
// dialogs.
const FALLBACK_KEYS = { approve: ['y'], deny: ['n'] } satisfies Record<PermitAction, string[]>;

// Resolve the tmux send-keys key names that answer the permission dialog on
// screen. Precedence: matched PERMIT rule's own keys > manifest defaults >
// literal y/n. Matching walks the manifest's PERMIT rules in order (first match
// wins, same contract as detection) over the same bottom window detection uses;
// no live PERMIT match refuses the shortcut. A hook/title alone cannot prove
// that sending an approval key to the current screen is safe.
export function resolvePermitKeysFromLines(
  lines: string[],
  manifest: DetectionManifest,
  action: PermitAction,
): string[] {
  // Use the detector's FULL ordering, not just its permission rules: a busy
  // indicator must beat an old approval prompt lingering in the transcript.
  if (detectFromPaneContent(lines, manifest).status !== AgentStatus.PERMIT) {
    throw new Error('No current permission dialog; inspect the target or use passthrough');
  }
  const bottomText = stripAnsi(lines.slice(-manifest.linesFromBottom).join('\n'));

  for (const rule of manifest.rules) {
    if (rule.state !== 'PERMIT') continue;
    const re = getCompiledRegex(rule);
    if (re && re.test(bottomText)) {
      const keys = action === 'approve' ? rule.approveKeys : rule.denyKeys;
      if (keys && keys.length > 0) return keys;
      break; // matched a PERMIT rule without its own keys — use the manifest default
    }
  }

  const defaults = action === 'approve' ? manifest.approveKeys : manifest.denyKeys;
  return defaults && defaults.length > 0 ? defaults : FALLBACK_KEYS[action];
}

// Live variant for the TUI keypress: capture the pane NOW (its dialog may have
// changed since the last scrape tick) and resolve against the owning agent's
// manifest. `agent` is AgentState.agentType; empty degrades to claude, matching
// the scrape path's default.
export function resolvePermitKeys(paneId: string, agent: string, action: PermitAction): string[] {
  const manifest = loadDetectionManifest(agent.length > 0 ? agent : 'claude');
  return resolvePermitKeysFromLines(capturePaneLines(paneId), manifest, action);
}
