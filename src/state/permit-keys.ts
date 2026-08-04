import { getCompiledRegex, loadDetectionManifest, type DetectionManifest } from './detection.ts';
import { capturePaneLines } from './scraper.ts';

export type PermitAction = 'approve' | 'deny';

// The literal y/n the TUI sent before answer keys were agent-aware. Kept as the
// last resort so unknown agents and user overrides without key specs behave
// exactly as before: correct for genuine [y/n] prompts, a no-op for menu
// dialogs.
const FALLBACK_KEYS: Record<PermitAction, string[]> = { approve: ['y'], deny: ['n'] };

// Resolve the tmux send-keys key names that answer the permission dialog on
// screen. Precedence: matched PERMIT rule's own keys > manifest defaults >
// literal y/n. Matching walks the manifest's PERMIT rules in order (first match
// wins, same contract as detection) over the same bottom window detection uses;
// no match falls through to the manifest defaults — that covers hook- and
// title-sourced PERMIT where the screen shows no known prompt text.
export function resolvePermitKeysFromLines(
  lines: string[],
  manifest: DetectionManifest,
  action: PermitAction,
): string[] {
  const bottomText = lines.slice(-manifest.linesFromBottom).join('\n');

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
