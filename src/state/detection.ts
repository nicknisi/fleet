import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isJsonObject, isNumber, isString, type JsonObject, type JsonValue } from '../json.ts';

// `state` is the serialized (JSON) label; it maps 1:1 onto the subset of
// AgentStatus values the scraper can emit (see RULE_STATE_TO_STATUS in scraper.ts).
export type RuleState = 'PERMIT' | 'QUESTION' | 'BUSY' | 'IDLE';

export interface DetectionRule {
  id: string;
  pattern: string; // JavaScript RegExp source (JSON-escaped on disk)
  flags?: string; // e.g. "i"
  state: RuleState;
  // tmux send-keys key names (e.g. ["y"], ["1"], ["Enter"], ["Escape"]) that
  // answer THIS prompt, for PERMIT rules whose dialog differs from the agent's
  // default (a genuine [y/n] prompt on an agent whose menus want Enter).
  // Optional: absent means the manifest-level keys apply.
  approveKeys?: string[];
  denyKeys?: string[];
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
  // Agent-level default answer keys for a PERMIT dialog (tmux send-keys key
  // names). Used when the matched PERMIT rule names no keys of its own, and for
  // hook/title-sourced PERMIT where no screen rule matched at all. Absent means
  // fall back to literal y/n (the pre-agent-aware behavior).
  approveKeys?: string[];
  denyKeys?: string[];
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
const SAFE_REGEX_FLAGS = /^[imsu]*$/;
const MAX_RULE_ID_LENGTH = 128;
const MAX_PATTERN_LENGTH = 1024;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

// Answer-key arrays from overrides: keep only non-empty strings; an empty or
// non-array value is treated as absent (fall through to the next default),
// never an error.
function validateKeys(raw: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keys = raw.filter((k): k is string => typeof k === 'string' && k.length > 0);
  return keys.length > 0 ? keys : undefined;
}

// Drop rules that reuse an id already seen, keeping the FIRST occurrence so
// first-match ordering is preserved. Built-ins have unique ids, so this only
// bites malformed overrides (e.g. an appendRules id colliding with a base rule).
function dedupeRules(rules: DetectionRule[], label: string): DetectionRule[] {
  const seen = new Set<string>();
  const out: DetectionRule[] = [];
  for (const r of rules) {
    if (seen.has(r.id)) {
      warn(`detection: duplicate ${label} id "${r.id}" — keeping the first, dropping the rest`);
      continue;
    }
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function validateRules(raw: JsonValue[], label = 'rule'): DetectionRule[] {
  const rules: DetectionRule[] = [];
  for (const r of raw) {
    if (!isJsonObject(r)) continue;
    const rule = r;
    if (!isString(rule.id) || !isString(rule.pattern)) continue;
    if (
      rule.id.length === 0 ||
      rule.id.length > MAX_RULE_ID_LENGTH ||
      hasControlCharacters(rule.id) ||
      rule.pattern.length > MAX_PATTERN_LENGTH
    ) {
      warn(`detection: rejecting ${label} with unsafe id or oversized pattern`);
      continue;
    }
    if (!isString(rule.state) || !VALID_STATES.has(rule.state)) continue;
    const flags = isString(rule.flags) ? rule.flags : undefined;
    // Cached RegExp objects must be stateless across ticks. Global/sticky flags
    // mutate lastIndex on test(), causing alternating matches; reject all flags
    // outside the safe, non-stateful set (and duplicate flag strings).
    if (flags && (!SAFE_REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length)) {
      warn(`detection: rejecting ${label} "${rule.id}" with unsafe regex flags "${flags}"`);
      continue;
    }
    const approveKeys = validateKeys(rule.approveKeys);
    const denyKeys = validateKeys(rule.denyKeys);
    const candidate: DetectionRule = {
      id: rule.id,
      pattern: rule.pattern,
      flags,
      // SAFETY: VALID_STATES membership was checked above; its elements are exactly RuleState.
      state: rule.state as RuleState,
    };
    if (approveKeys) candidate.approveKeys = approveKeys;
    if (denyKeys) candidate.denyKeys = denyKeys;
    // Drop bad-regex rules at load with one warning (not once per scrape).
    if (getCompiledRegex(candidate) === null) continue;
    rules.push(candidate);
  }
  return dedupeRules(rules, label);
}

function validateManifest(raw: JsonValue, agent: string): DetectionManifest {
  if (!isJsonObject(raw)) throw new Error('manifest is not an object');
  const m = raw;
  if (!Array.isArray(m.rules)) throw new Error('manifest.rules must be an array');

  // titleRules is optional; a non-array value is treated as absent, not an error.
  const titleRules = Array.isArray(m.titleRules) ? validateRules(m.titleRules) : undefined;
  const approveKeys = validateKeys(m.approveKeys);
  const denyKeys = validateKeys(m.denyKeys);
  const manifest: DetectionManifest = {
    agent,
    linesFromBottom:
      isNumber(m.linesFromBottom) && m.linesFromBottom > 0 ? m.linesFromBottom : DEFAULT_LINES_FROM_BOTTOM,
    promptMarker: isString(m.promptMarker) ? m.promptMarker : '',
    rules: validateRules(m.rules),
  };
  if (titleRules) manifest.titleRules = titleRules;
  if (approveKeys) manifest.approveKeys = approveKeys;
  if (denyKeys) manifest.denyKeys = denyKeys;
  return manifest;
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

// --- schemaVersion:1 override envelopes -------------------------------------
// A legacy override (no `schemaVersion`) still replaces the built-in WHOLESALE
// (validateManifest). A `schemaVersion: 1` envelope instead INHERITS a built-in
// (`extends`, default the same agent) and applies explicit, stable-id operations
// on top of it — appendRules / replaceRules (in-place, by id) / disableRules for
// the screen rules, the *TitleRules variants for title rules, plus scalar
// overrides (linesFromBottom, promptMarker, approveKeys, denyKeys). Everything
// degrades safely: an unknown schemaVersion or an unknown `extends` warns and
// falls back to the built-in rather than throwing.
export const SUPPORTED_SCHEMA_VERSION = 1;

interface RuleOpKeys {
  append: string;
  replace: string;
  disable: string;
}

// Apply the three rule operations to a base rule list, preserving first-match
// ordering: replaceRules swaps a rule in place by id, disableRules removes by
// id, appendRules adds to the end. Unknown target ids for replace/disable warn
// and are skipped (never throw). The combined result is de-duplicated so an
// appended id colliding with a base id can't shadow ordering.
function applyRuleOps(base: DetectionRule[], m: JsonObject, keys: RuleOpKeys, label: string): DetectionRule[] {
  let rules = [...base];

  const replaceRaw = m[keys.replace];
  if (Array.isArray(replaceRaw)) {
    for (const rep of validateRules(replaceRaw, label)) {
      const idx = rules.findIndex((r) => r.id === rep.id);
      if (idx === -1) {
        warn(`detection: ${keys.replace} id "${rep.id}" matches no base ${label} — ignored`);
        continue;
      }
      rules[idx] = rep;
    }
  }

  const disableRaw = m[keys.disable];
  if (Array.isArray(disableRaw)) {
    const ids = new Set(disableRaw.filter((x): x is string => typeof x === 'string' && x.length > 0));
    for (const id of ids) {
      if (!rules.some((r) => r.id === id))
        warn(`detection: ${keys.disable} id "${id}" matches no base ${label} — ignored`);
    }
    rules = rules.filter((r) => !ids.has(r.id));
  }

  const appendRaw = m[keys.append];
  if (Array.isArray(appendRaw)) rules.push(...validateRules(appendRaw, label));

  return dedupeRules(rules, label);
}

// Resolve a `schemaVersion:1` envelope against the built-ins. Returns null when
// the schema is unrecognized so the caller falls back to the built-in.
function resolveSchemaOverride(m: JsonObject, agent: string): DetectionManifest | null {
  if (m.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    warn(
      `detection: unknown schemaVersion ${JSON.stringify(m.schemaVersion)} in override for "${agent}" — using built-in`,
    );
    return null;
  }

  // `extends` selects which built-in to inherit; default is the agent's own.
  // An unknown target warns and falls back to the agent's own built-in.
  let baseAgent = agent;
  if (m.extends !== undefined) {
    if (isString(m.extends) && builtinFor(m.extends)) {
      baseAgent = m.extends;
    } else {
      warn(
        `detection: unknown extends ${JSON.stringify(m.extends)} in override for "${agent}" — inheriting "${agent}" built-in`,
      );
    }
  }
  const base: DetectionManifest = builtinFor(baseAgent) ??
    builtinFor(agent) ?? { agent, linesFromBottom: DEFAULT_LINES_FROM_BOTTOM, promptMarker: '', rules: [] };

  const rules = applyRuleOps(
    base.rules,
    m,
    { append: 'appendRules', replace: 'replaceRules', disable: 'disableRules' },
    'rule',
  );
  const titleRules = applyRuleOps(
    base.titleRules ?? [],
    m,
    { append: 'appendTitleRules', replace: 'replaceTitleRules', disable: 'disableTitleRules' },
    'title rule',
  );

  const approveKeys = validateKeys(m.approveKeys) ?? base.approveKeys;
  const denyKeys = validateKeys(m.denyKeys) ?? base.denyKeys;

  const resolved: DetectionManifest = {
    agent,
    linesFromBottom: isNumber(m.linesFromBottom) && m.linesFromBottom > 0 ? m.linesFromBottom : base.linesFromBottom,
    promptMarker: isString(m.promptMarker) ? m.promptMarker : base.promptMarker,
    rules,
  };
  if (titleRules.length > 0) resolved.titleRules = titleRules;
  if (approveKeys) resolved.approveKeys = approveKeys;
  if (denyKeys) resolved.denyKeys = denyKeys;
  return resolved;
}

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
    {
      id: 'permit.yn',
      pattern: '\\[y/n\\]|\\[Y/n\\]',
      flags: 'i',
      state: 'PERMIT',
      approveKeys: ['y'],
      denyKeys: ['n'],
    },
    { id: 'permit.do-you-want', pattern: 'Do you want to (proceed|allow)', state: 'PERMIT' },
    // Field-tested Claude Code permission-dialog phrases (herdr/tmux-agents-mon
    // agents/claude.conf BLOCKED_SCREEN) fleet previously missed. All are
    // case-insensitive; the manifest-level approve/deny keys (1 / Escape) apply.
    { id: 'permit.waiting-for-permission', pattern: 'waiting for permission', flags: 'i', state: 'PERMIT' },
    { id: 'permit.allow-connection', pattern: 'do you want to allow this connection\\?', flags: 'i', state: 'PERMIT' },
    { id: 'permit.tab-to-amend', pattern: 'tab to amend', flags: 'i', state: 'PERMIT' },
    { id: 'permit.ctrl-e-explain', pattern: 'ctrl\\+e to explain', flags: 'i', state: 'PERMIT' },
    { id: 'permit.dynamic-workflow', pattern: 'run a dynamic workflow\\?', flags: 'i', state: 'PERMIT' },
    { id: 'question.enter-select', pattern: 'Enter to select.*[↑↓]|Esc to cancel', state: 'QUESTION' },
    { id: 'busy.spinner-glyph', pattern: WORKING_GLYPH_PATTERN, state: 'BUSY' },
  ],
  // Claude paints dingbat spinners (✳✢✶✻✽) on SCREEN but a braille frame in the
  // TITLE while working — so the title, not the glyph rule above, is the reliable
  // fast-cycle working signal for a hook-less claude.
  titleRules: [{ id: 'busy.title-spinner', pattern: WORKING_TITLE_PATTERN, state: 'BUSY' }],
  // Claude's permission dialog is a numbered select menu ("❯ 1. Yes / 2. … / 3.
  // No"), not a y/n prompt: a literal 'y' is ignored (issue #40). '1' selects
  // "Yes" explicitly regardless of the highlighted row; Esc always cancels
  // ("Esc to cancel" in the dialog footer). The permit.yn rule above overrides
  // these for a genuine [y/n] prompt.
  approveKeys: ['1'],
  denyKeys: ['Escape'],
};

// --- the embedded built-in `codex` manifest (Phase 3) ---
// Codex fires PreToolUse+Stop hooks, so BUSY/DONE come from the hook (which is
// authoritative and faster than any spinner regex). A busy.esc-interrupt screen
// rule is kept as a hook-less fallback (herdr WORKING_SCREEN) so a captured
// working frame still reads BUSY when no hook is wired. Codex has no Notification
// hook and its on-screen prompts don't cleanly
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
    { id: 'permit.yn', pattern: '\\[y/n\\]', flags: 'i', state: 'PERMIT', approveKeys: ['y'], denyKeys: ['n'] },
    { id: 'permit.do-you-want', pattern: 'do you want to', flags: 'i', state: 'PERMIT' },
    // Hook-less BUSY fallback (herdr WORKING_SCREEN='esc to interrupt'). Codex's
    // PreToolUse+Stop hooks are authoritative and faster, so this only lands
    // when no hook is wired — it never overrides a permit rule above it.
    { id: 'busy.esc-interrupt', pattern: 'esc to interrupt', flags: 'i', state: 'BUSY' },
  ],
  // Codex retitles its pane "Action Required" while blocked on approval — the
  // signal its missing Notification hook never provides — and prefixes a braille
  // frame while working. Blocked-title outranks working-title (herdr priorities:
  // 1100 > 1050).
  titleRules: [
    { id: 'permit.title-action-required', pattern: 'Action Required', state: 'PERMIT' },
    { id: 'busy.title-spinner', pattern: WORKING_TITLE_PATTERN, state: 'BUSY' },
  ],
  // Codex approval panels are arrow-select menus with "Yes" preselected
  // ("press enter to confirm or esc to cancel" is the dialog's own footer), so
  // Enter approves and Esc denies; permit.yn above overrides for [y/n] prompts.
  approveKeys: ['Enter'],
  denyKeys: ['Escape'],
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
  // opencode's permission dialog is a button row ("Allow once / Allow always /
  // Reject") with "Allow once" preselected and "enter confirm · esc dismiss" as
  // its footer — a literal 'y' is ignored (issue #40).
  approveKeys: ['Enter'],
  denyKeys: ['Escape'],
};

// --- the embedded built-in `pi` manifest ---
// pi (npm: @mariozechner/pi-coding-agent) is wired via a fleet extension, not
// scraping. The fleet-pi extension subscribes to pi's lifecycle events for
// BUSY/DONE/IDLE and to rpiv-ask-user-question's stable blocked event for
// QUESTION, writing each state to ~/.cache/pi-status. pi auto-runs its tools, so
// there is no interactive "[y/n]" permission prompt to scrape. The manifest is
// intentionally empty; it exists so `pi` resolves to a built-in (no "no
// manifest" warning) and is a registered, known agent. A user can still drop a
// ~/.config/fleet/detection/pi.json override to add scrape rules for another
// question UI that does not publish a blocked event.
export const PI_MANIFEST: DetectionManifest = {
  agent: 'pi',
  linesFromBottom: 15,
  promptMarker: '',
  rules: [],
};

// --- loader: built-in, replaced wholesale by a valid override ---
const BUILTINS = {
  claude: CLAUDE_MANIFEST,
  codex: CODEX_MANIFEST,
  pi: PI_MANIFEST,
  opencode: OPENCODE_MANIFEST,
} satisfies Record<string, DetectionManifest>;

function builtinFor(agent: string): DetectionManifest | undefined {
  if (!Object.hasOwn(BUILTINS, agent)) return undefined;
  // SAFETY: the Object.hasOwn check above proves agent is a key of BUILTINS.
  return BUILTINS[agent as keyof typeof BUILTINS];
}
const manifestCache = new Map<string, DetectionManifest>();

export function loadDetectionManifest(agent: string): DetectionManifest {
  const cached = manifestCache.get(agent);
  if (cached) return cached;

  const builtin = builtinFor(agent) ?? null;
  const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const overridePath = join(configDir, 'fleet', 'detection', `${agent}.json`);

  let resolved: DetectionManifest | null = builtin;
  if (existsSync(overridePath)) {
    try {
      // SAFETY: JSON.parse returns any; JsonValue is the sound type of any JSON document.
      const parsed = JSON.parse(readFileSync(overridePath, 'utf-8')) as JsonValue;
      if (isJsonObject(parsed) && 'schemaVersion' in parsed) {
        // schemaVersion:1 envelope — INHERIT the built-in and apply operations.
        // An unrecognized schema returns null; fall back to the built-in.
        resolved = resolveSchemaOverride(parsed, agent) ?? builtin;
      } else {
        resolved = validateManifest(parsed, agent); // legacy override REPLACES built-in wholesale
      }
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
