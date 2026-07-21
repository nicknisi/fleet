import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `state` is the serialized (JSON) label; it maps 1:1 onto the subset of
// AgentStatus values the scraper can emit (see RULE_STATE_TO_STATUS in scraper.ts).
export type RuleState = 'PERMIT' | 'QUESTION' | 'BUSY' | 'IDLE';

export interface DetectionRule {
  id: string;
  pattern: string; // JavaScript RegExp source (JSON-escaped on disk)
  flags?: string; // e.g. "i"
  state: RuleState;
}

export interface DetectionManifest {
  agent: string;
  linesFromBottom: number; // rule-match window; default 15 (matches the old scraper window)
  promptMarker: string; // if NO rule matches, present => IDLE, absent => null
  rules: DetectionRule[]; // ORDERED; first match wins
  // Rules matched against #{pane_title} instead of the screen. The title comes
  // free with the fast tick's one list-panes call, so title-sourced state lands
  // on the FAST cycle — no capture-pane, and immune to transcript-text spoofing
  // (a pane can print "esc to interrupt"; it can't retitle itself mid-turn
  // without the harness doing it). ORDERED; first match wins. Optional: absent
  // means the agent has no title signal.
  titleRules?: DetectionRule[];
}

const DEFAULT_LINES_FROM_BOTTOM = 15;

// The prompt-marker fallback is not a `rules` entry, but it still names the
// branch that fired so `fleet explain` can show why the scraper read IDLE. This
// is the id the post-Phase-1 regression lock (scraper.test.ts) asserts.
export const PROMPT_MARKER_RULE_ID = 'idle.prompt';

function warn(msg: string): void {
  // Never throw from detection; degrade to built-in and tell stderr.
  process.stderr.write(`fleet: ${msg}\n`);
}

// --- regex compile + cache (compile once per pattern+flags) ---
const regexCache = new Map<string, RegExp | null>();

export function getCompiledRegex(rule: DetectionRule): RegExp | null {
  // Null byte separator so `{flags,pattern}` can never collide with a
  // different `{flags,pattern}` pair that happens to concatenate the same way.
  const key = `${rule.flags ?? ''}\0${rule.pattern}`;
  const hit = regexCache.get(key);
  if (hit !== undefined) return hit;
  let re: RegExp | null;
  try {
    re = new RegExp(rule.pattern, rule.flags);
  } catch (err) {
    warn(`detection: skipping rule "${rule.id}" — bad pattern /${rule.pattern}/${rule.flags ?? ''}: ${String(err)}`);
    re = null;
  }
  regexCache.set(key, re);
  return re;
}

// --- override validation (schema only; JSON.parse already ran) ---
const VALID_STATES: ReadonlySet<string> = new Set(['PERMIT', 'QUESTION', 'BUSY', 'IDLE']);

function validateRules(raw: unknown[]): DetectionRule[] {
  const rules: DetectionRule[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const rule = r as Record<string, unknown>;
    if (typeof rule.id !== 'string' || typeof rule.pattern !== 'string') continue;
    if (typeof rule.state !== 'string' || !VALID_STATES.has(rule.state)) continue;
    const flags = typeof rule.flags === 'string' ? rule.flags : undefined;
    const candidate: DetectionRule = {
      id: rule.id,
      pattern: rule.pattern,
      flags,
      state: rule.state as RuleState,
    };
    // Drop bad-regex rules at load with one warning (not once per scrape).
    if (getCompiledRegex(candidate) === null) continue;
    rules.push(candidate);
  }
  return rules;
}

function validateManifest(raw: unknown, agent: string): DetectionManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest is not an object');
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.rules)) throw new Error('manifest.rules must be an array');

  return {
    agent,
    linesFromBottom:
      typeof m.linesFromBottom === 'number' && m.linesFromBottom > 0 ? m.linesFromBottom : DEFAULT_LINES_FROM_BOTTOM,
    promptMarker: typeof m.promptMarker === 'string' ? m.promptMarker : '',
    rules: validateRules(m.rules),
    // titleRules is optional; a non-array value is treated as absent, not an error.
    ...(Array.isArray(m.titleRules) ? { titleRules: validateRules(m.titleRules) } : {}),
  };
}

// Braille block U+2800–U+28FF: the animated progress glyph a harness paints only
// while it is actively working, so it cannot be spoofed by transcript text and does
// not depend on any English string. Exported so Phase 3's standalone discovery check
// reuses this exact range rather than duplicating it.
// Calibration source: the agent-radar reference poller matches this same range
// byte-wise (E2 A0-A3 xx = U+2800–U+28FF) for the claude/codex/pi working glyph
// (agent-radar scripts/agent-radar-poller, docs/adr/detection-mechanism.md).
export const WORKING_GLYPH_PATTERN = '[\\u2800-\\u28FF]';

// A leading braille frame + space in #{pane_title} — the one-character spinner a
// harness prepends to its title only while a turn is actively running (real
// captured titles: claude "⠂ fix flaky tests", codex "⠇ refactor auth module").
// Anchored so a braille char deeper in a title can't false-positive. Shared by
// the claude and codex title rules.
const WORKING_TITLE_PATTERN = `^${WORKING_GLYPH_PATTERN} `;

// --- the embedded built-in `claude` manifest ---
// Each rule id, pattern, flag, and state is a direct translation of the literal
// regexes the scraper used before Phase 2. Ordering (first match wins) is
// deliberate and in three tiers:
//   1. Live-only BUSY rules first (token counter, esc-to-interrupt). These render
//      ONLY while a turn is actively running and vanish when a dialog is up, so
//      they safely outrank PERMIT/QUESTION: an ANSWERED "Do you want to proceed?"
//      lingering in the bottom window while the counter ticks must read BUSY —
//      the engine trusts scrape PERMIT absolutely (engine.ts), so permit-first
//      ordering turned every lingering prompt into a false "waiting". (Same
//      working-beats-blocked priority herdr/agent-radar ships for claude.)
//   2. PERMIT/QUESTION prompt rules. A genuine dialog suspends the counter and
//      the esc-to-interrupt hint (see the claude-blocked fixture), so tier 1
//      never shadows a real prompt.
//   3. busy.spinner-glyph LAST: a braille char is a weaker signal (it can appear
//      quoted in transcript text), so a pane showing both a glyph and a [y/n]
//      prompt still reads PERMIT.
// Compiled into the binary (bun build --compile ships no source tree), so this
// is a TS object literal, never a runtime file read.
export const CLAUDE_MANIFEST: DetectionManifest = {
  agent: 'claude',
  linesFromBottom: 15,
  promptMarker: '❯',
  rules: [
    { id: 'busy.token-counter-min', pattern: '\\(\\d+m\\s+\\d+s\\s+·.*tokens?\\)', state: 'BUSY' },
    { id: 'busy.token-counter-sec', pattern: '\\(\\d+s\\s+·.*tokens?\\)', state: 'BUSY' },
    { id: 'busy.esc-interrupt', pattern: 'esc to interrupt', flags: 'i', state: 'BUSY' },
    { id: 'permit.yn', pattern: '\\[y/n\\]|\\[Y/n\\]', flags: 'i', state: 'PERMIT' },
    { id: 'permit.do-you-want', pattern: 'Do you want to (proceed|allow)', state: 'PERMIT' },
    { id: 'question.enter-select', pattern: 'Enter to select.*[↑↓]|Esc to cancel', state: 'QUESTION' },
    { id: 'busy.spinner-glyph', pattern: WORKING_GLYPH_PATTERN, state: 'BUSY' },
  ],
  // Claude paints dingbat spinners (✳✢✶✻✽) on SCREEN but a braille frame in the
  // TITLE while working — so the title, not the glyph rule above, is the reliable
  // fast-cycle working signal for a hook-less claude.
  titleRules: [{ id: 'busy.title-spinner', pattern: WORKING_TITLE_PATTERN, state: 'BUSY' }],
};

// --- the embedded built-in `codex` manifest (Phase 3) ---
// Codex fires PreToolUse+Stop hooks, so BUSY/DONE come from the hook (which is
// authoritative and faster than any spinner regex) — no BUSY scrape rule is
// needed. Codex has no Notification hook and its on-screen prompts don't cleanly
// separate a permission request from a question, so every prompt rule is PERMIT
// (QUESTION is not currently sourced for Codex — a documented limitation). Rules
// are ORDERED, first match wins, exactly like CLAUDE_MANIFEST; ids follow the
// same `<state>.<slug>` convention. A TS object literal (never a runtime file
// read) so `bun build --compile` bundles it into the binary.
export const CODEX_MANIFEST: DetectionManifest = {
  agent: 'codex',
  linesFromBottom: 15,
  promptMarker: '❯',
  rules: [
    { id: 'permit.allow', pattern: 'allow command\\?', flags: 'i', state: 'PERMIT' },
    { id: 'permit.confirm', pattern: 'press enter to confirm or esc to cancel', flags: 'i', state: 'PERMIT' },
    { id: 'permit.yn', pattern: '\\[y/n\\]', flags: 'i', state: 'PERMIT' },
    { id: 'permit.do-you-want', pattern: 'do you want to', flags: 'i', state: 'PERMIT' },
  ],
  // Codex retitles its pane "Action Required" while blocked on approval — the
  // signal its missing Notification hook never provides — and prefixes a braille
  // frame while working. Blocked-title outranks working-title (herdr priorities:
  // 1100 > 1050).
  titleRules: [
    { id: 'permit.title-action-required', pattern: 'Action Required', state: 'PERMIT' },
    { id: 'busy.title-spinner', pattern: WORKING_TITLE_PATTERN, state: 'BUSY' },
  ],
};

// --- the embedded built-in `opencode` manifest ---
// Ported from herdr/agent-radar's opencode manifest and verified against real
// captured opencode frames. Fleet has no opencode hook integration, so every
// state here is scrape-sourced: opencode was previously only discoverable as
// BUSY/IDLE via the process scan and could never show a permission prompt.
// PERMIT rules precede BUSY (upstream priority is blocked-before-working for
// opencode). No promptMarker: opencode's composer has no stable idle marker we
// have a fixture for, so an unmatched screen stays null rather than guessing
// IDLE.
export const OPENCODE_MANIFEST: DetectionManifest = {
  agent: 'opencode',
  linesFromBottom: 15,
  promptMarker: '',
  rules: [
    { id: 'permit.required', pattern: '△ Permission required', state: 'PERMIT' },
    {
      id: 'permit.dismiss-confirm',
      pattern:
        'esc dismiss.*(enter confirm|enter submit|enter toggle)|(enter confirm|enter submit|enter toggle).*esc dismiss',
      state: 'PERMIT',
    },
    {
      id: 'busy.esc-interrupt',
      pattern: 'esc to interrupt|ctrl\\+c to interrupt|press esc to interrupt|esc again to interrupt',
      state: 'BUSY',
    },
    // The block-character progress bar (■■■■■■⬝⬝⬝⬝⬝⬝) opencode animates while
    // working; ≥4 in a row so a stray box-drawing char can't false-positive.
    { id: 'busy.progress-bar', pattern: '(■|⬝){4,}', state: 'BUSY' },
  ],
};

// --- the embedded built-in `pi` manifest ---
// pi (npm: @mariozechner/pi-coding-agent) is wired via a fleet extension, not
// scraping:
// the fleet-pi extension subscribes to pi's agent_start / tool_execution_start /
// agent_end lifecycle events and writes working/done to ~/.cache/pi-status, so
// BUSY/DONE/IDLE are hook-sourced and authoritative. pi auto-runs its tools —
// there is no interactive "[y/n]" permission prompt or selection dialog on the
// screen to match — so there are no PERMIT/QUESTION scrape rules (a documented
// limitation, mirroring Codex's absent QUESTION). The manifest is intentionally
// empty; it exists so `pi` resolves to a built-in (no "no manifest" warning) and
// is a registered, known agent. A user can still drop a ~/.config/fleet/detection/
// pi.json override to add scrape rules.
export const PI_MANIFEST: DetectionManifest = {
  agent: 'pi',
  linesFromBottom: 15,
  promptMarker: '',
  rules: [],
};

// --- loader: built-in, replaced wholesale by a valid override ---
const BUILTINS: Record<string, DetectionManifest> = {
  claude: CLAUDE_MANIFEST,
  codex: CODEX_MANIFEST,
  pi: PI_MANIFEST,
  opencode: OPENCODE_MANIFEST,
};
const manifestCache = new Map<string, DetectionManifest>();

export function loadDetectionManifest(agent: string): DetectionManifest {
  const cached = manifestCache.get(agent);
  if (cached) return cached;

  const builtin = BUILTINS[agent] ?? null;
  const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const overridePath = join(configDir, 'fleet', 'detection', `${agent}.json`);

  let resolved: DetectionManifest | null = builtin;
  if (existsSync(overridePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(overridePath, 'utf-8'));
      resolved = validateManifest(parsed, agent); // override REPLACES built-in
    } catch (err) {
      warn(`detection: ignoring malformed override ${overridePath} — ${String(err)}; using built-in`);
      resolved = builtin;
    }
  }

  if (!resolved) {
    warn(`detection: no built-in or override manifest for agent "${agent}"; scrape detection disabled`);
    resolved = { agent, linesFromBottom: DEFAULT_LINES_FROM_BOTTOM, promptMarker: '', rules: [] };
  }

  manifestCache.set(agent, resolved);
  return resolved;
}

// Test seam: overrides are memoized per agent; tests reset the caches between
// cases so a fresh temp override (or a bad regex) is re-read, not served stale.
export function __resetManifestCache(): void {
  manifestCache.clear();
  regexCache.clear();
}
