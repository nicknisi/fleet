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

function validateManifest(raw: unknown, agent: string): DetectionManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest is not an object');
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.rules)) throw new Error('manifest.rules must be an array');

  const rules: DetectionRule[] = [];
  for (const r of m.rules) {
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

  return {
    agent,
    linesFromBottom:
      typeof m.linesFromBottom === 'number' && m.linesFromBottom > 0 ? m.linesFromBottom : DEFAULT_LINES_FROM_BOTTOM,
    promptMarker: typeof m.promptMarker === 'string' ? m.promptMarker : '',
    rules,
  };
}

// --- the embedded built-in `claude` manifest (byte-for-byte reproduction) ---
// Each rule id, pattern, flag, and state is a direct translation of the literal
// regexes the scraper used before Phase 2, in the same statement order. First
// match wins, so PERMIT/QUESTION rules precede the BUSY rules exactly as the old
// control flow did. Compiled into the binary (bun build --compile ships no
// source tree), so this is a TS object literal, never a runtime file read.
export const CLAUDE_MANIFEST: DetectionManifest = {
  agent: 'claude',
  linesFromBottom: 15,
  promptMarker: '❯',
  rules: [
    { id: 'permit.yn', pattern: '\\[y/n\\]|\\[Y/n\\]', flags: 'i', state: 'PERMIT' },
    { id: 'permit.do-you-want', pattern: 'Do you want to (proceed|allow)', state: 'PERMIT' },
    { id: 'question.enter-select', pattern: 'Enter to select.*[↑↓]|Esc to cancel', state: 'QUESTION' },
    { id: 'busy.token-counter-min', pattern: '\\(\\d+m\\s+\\d+s\\s+·.*tokens?\\)', state: 'BUSY' },
    { id: 'busy.token-counter-sec', pattern: '\\(\\d+s\\s+·.*tokens?\\)', state: 'BUSY' },
    { id: 'busy.esc-interrupt', pattern: 'esc to interrupt', flags: 'i', state: 'BUSY' },
  ],
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
const BUILTINS: Record<string, DetectionManifest> = { claude: CLAUDE_MANIFEST, codex: CODEX_MANIFEST, pi: PI_MANIFEST };
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
