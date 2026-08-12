import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFromPaneContent, detectFromTitle } from './scraper.ts';
import {
  __resetManifestCache,
  CLAUDE_MANIFEST,
  OPENCODE_MANIFEST,
  loadDetectionManifest,
  type DetectionManifest,
} from './detection.ts';
import { AgentStatus } from './types.ts';

const originalXdg = process.env.XDG_CONFIG_HOME;
let tempDirs: string[] = [];
let stderrSpy!: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;

function writeOverride(agent: string, contents: string): string {
  const cfg = mkdtempSync(join(tmpdir(), 'fleet-detect-'));
  const dir = join(cfg, 'fleet', 'detection');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent}.json`), contents);
  tempDirs.push(cfg);
  return cfg;
}

beforeEach(() => {
  __resetManifestCache();
  tempDirs = [];
  // Silence + capture detection warnings; specific tests assert on the spy.
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  __resetManifestCache();
});

// 1. Built-in reproduction — an independent guard that CLAUDE_MANIFEST matches the
//    pre-Phase-2 scraper on every single-signal frame, so a manifest edit that
//    diverges is caught even if the frozen scraper.test.ts somehow didn't. (Rule
//    ORDER intentionally departs from pre-Phase-2: live BUSY indicators now
//    precede prompt rules — see the lingering-prompt suite below — but each case
//    here shows exactly one signal, so outcomes are order-independent.) Marker
//    cases assert 'idle.prompt' (the id the regression lock asserts), not null.
describe('CLAUDE_MANIFEST reproduces the pre-Phase-2 scraper', () => {
  const cases: Array<{ name: string; lines: string[]; status: AgentStatus | null; ruleId: string | null }> = [
    { name: 'permit [y/n]', lines: ['Allow Edit?', '[y/n]'], status: AgentStatus.PERMIT, ruleId: 'permit.yn' },
    { name: 'permit [Y/n]', lines: ['Allow Read?', '[Y/n]'], status: AgentStatus.PERMIT, ruleId: 'permit.yn' },
    {
      name: 'permit do-you-want',
      lines: ['Do you want to proceed?'],
      status: AgentStatus.PERMIT,
      ruleId: 'permit.do-you-want',
    },
    {
      name: 'question enter-select',
      lines: ['Enter to select · ↑/↓ to navigate · Esc to cancel'],
      status: AgentStatus.QUESTION,
      ruleId: 'question.enter-select',
    },
    {
      name: 'busy token counter (minutes)',
      lines: ['✻ Trapping Gollum… (1m 11s · ↓ 3.4k tokens)', '', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.token-counter-min',
    },
    {
      name: 'busy token counter (seconds)',
      lines: ['✢ Sharting… (8s · ↑ 240 tokens)', '', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.token-counter-sec',
    },
    {
      name: 'busy esc to interrupt',
      lines: ['Running command…', '', '(esc to interrupt)', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.esc-interrupt',
    },
    { name: 'idle prompt marker', lines: ['Done!', '', '❯'], status: AgentStatus.IDLE, ruleId: 'idle.prompt' },
    {
      name: 'bare spinner + prompt reads idle via marker',
      lines: ['✶ Thinking…', '', '❯'],
      status: AgentStatus.IDLE,
      ruleId: 'idle.prompt',
    },
    { name: 'no match', lines: ['$ ls', 'file1.ts', 'file2.ts'], status: null, ruleId: null },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = detectFromPaneContent(c.lines, CLAUDE_MANIFEST);
      expect(r.status).toBe(c.status);
      expect(r.ruleId).toBe(c.ruleId);
    });
  }
});

// 1b. Phase 1 — braille working-glyph BUSY rule (busy.spinner-glyph). The animated
//     braille glyph (U+2800–U+28FF) is a positive "working" signal no English string
//     can spoof; a pane that merely QUOTES `esc to interrupt` (no live glyph) must not
//     read BUSY via THIS rule. Range boundaries are asserted inclusive.
describe('busy.spinner-glyph: braille working glyph → BUSY', () => {
  const cases: Array<{ name: string; lines: string[]; status: AgentStatus | null; ruleId: string | null }> = [
    {
      name: 'braille glyph alone → BUSY via the glyph rule',
      lines: ['⠹ Puzzling…', '', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.spinner-glyph',
    },
    {
      name: 'a different braille frame also matches',
      lines: ['⠏ Herding…', '', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.spinner-glyph',
    },
    // Inclusive range boundaries U+2800..U+28FF.
    {
      name: 'lower boundary U+2800 matches',
      lines: ['⠀ working', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.spinner-glyph',
    },
    {
      name: 'upper boundary U+28FF matches',
      lines: ['⣿ working', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.spinner-glyph',
    },
    // Just outside the range must NOT read BUSY via the glyph (→ idle via marker).
    {
      name: 'just below range (U+27FF) is not a glyph',
      lines: ['⟿ Thinking…', '❯'],
      status: AgentStatus.IDLE,
      ruleId: 'idle.prompt',
    },
    {
      name: 'just above range (U+2900) is not a glyph',
      lines: ['⤀ Thinking…', '❯'],
      status: AgentStatus.IDLE,
      ruleId: 'idle.prompt',
    },
    // Dingbat "star" spinners (U+2736 etc.) are NOT braille → no false BUSY here.
    {
      name: 'dingbat star spinner is not caught by the braille rule',
      lines: ['✶ Thinking…', '', '❯'],
      status: AgentStatus.IDLE,
      ruleId: 'idle.prompt',
    },
    // Quoted `esc to interrupt` with NO glyph still resolves via busy.esc-interrupt,
    // NOT via the glyph rule — guards the braille range against matching ASCII.
    {
      name: 'quoted esc-to-interrupt (no glyph) wins via the esc rule, not the glyph rule',
      lines: ['(esc to interrupt)', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.esc-interrupt',
    },
    // Pure ASCII punctuation (stars, brackets, mid-dot, em dash) → no BUSY via glyph.
    {
      name: 'ascii punctuation only → not BUSY via the glyph rule',
      lines: ['done * [ok] a·b — no braille', '❯'],
      status: AgentStatus.IDLE,
      ruleId: 'idle.prompt',
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = detectFromPaneContent(c.lines, CLAUDE_MANIFEST);
      expect(r.status).toBe(c.status);
      expect(r.ruleId).toBe(c.ruleId);
    });
  }
});

// 1c. Ordering guard: busy.spinner-glyph is appended LAST, so any earlier rule wins
//     even when a braille glyph is co-present on the same window (first-match-wins).
describe('busy.spinner-glyph is last: earlier rules win when a glyph is also present', () => {
  const cases: Array<{ name: string; lines: string[]; status: AgentStatus; ruleId: string }> = [
    {
      name: 'PERMIT [y/n] beats a co-present glyph',
      lines: ['Allow Edit? [y/n]', '⠹ working', '❯'],
      status: AgentStatus.PERMIT,
      ruleId: 'permit.yn',
    },
    {
      name: 'QUESTION selector beats a co-present glyph',
      lines: ['Enter to select · ↑/↓ to navigate · Esc to cancel', '⠹', '❯'],
      status: AgentStatus.QUESTION,
      ruleId: 'question.enter-select',
    },
    {
      name: 'token-counter beats the glyph (ruleId stays specific for `fleet explain`)',
      lines: ['⠹ Trapping Gollum… (8s · ↑ 240 tokens)', '', '❯'],
      status: AgentStatus.BUSY,
      ruleId: 'busy.token-counter-sec',
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(detectFromPaneContent(c.lines, CLAUDE_MANIFEST)).toEqual({ status: c.status, ruleId: c.ruleId });
    });
  }
});

// 2. Ordered precedence — proves "first match wins", not "most specific wins".
test('ordered rules: the first matching rule wins on text that matches several', () => {
  const both = ['Do you want to proceed? (8s · ↑ 240 tokens)'];
  const permitFirst: DetectionManifest = {
    agent: 't',
    linesFromBottom: 15,
    promptMarker: '',
    rules: [
      { id: 'p', pattern: 'Do you want to (proceed|allow)', state: 'PERMIT' },
      { id: 'b', pattern: '\\(\\d+s\\s+·.*tokens?\\)', state: 'BUSY' },
    ],
  };
  expect(detectFromPaneContent(both, permitFirst)).toEqual({ status: AgentStatus.PERMIT, ruleId: 'p' });

  const busyFirst: DetectionManifest = { ...permitFirst, rules: [permitFirst.rules[1]!, permitFirst.rules[0]!] };
  expect(detectFromPaneContent(both, busyFirst)).toEqual({ status: AgentStatus.BUSY, ruleId: 'b' });
});

// 3. Override replaces built-in wholesale (never merges).
test('a valid user override replaces the built-in manifest entirely', () => {
  const cfg = writeOverride(
    'claude',
    JSON.stringify({
      agent: 'claude',
      linesFromBottom: 15,
      promptMarker: '❯',
      rules: [{ id: 'q.only', pattern: 'PICK ONE', state: 'QUESTION' }],
    }),
  );
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('claude');
  // Only the override's rule survives — built-in permit/busy rules are gone.
  expect(m.rules.map((r) => r.id)).toEqual(['q.only']);
  // A [y/n] screen the built-in would call PERMIT now matches nothing.
  expect(detectFromPaneContent(['Allow Edit? [y/n]'], m).status).toBeNull();
  // The override's own rule fires.
  expect(detectFromPaneContent(['PICK ONE of these'], m)).toEqual({ status: AgentStatus.QUESTION, ruleId: 'q.only' });
});

// 3b. Answer keys (issue #40) ride the override path: valid rule- and
//     manifest-level key arrays survive validation; junk entries are dropped and
//     an all-junk array is treated as absent, never an error.
test('an override carries approve/deny keys; junk key values are dropped', () => {
  const cfg = writeOverride(
    'claude',
    JSON.stringify({
      agent: 'claude',
      rules: [{ id: 'permit.yn', pattern: '\\[y/n\\]', state: 'PERMIT', approveKeys: ['y', 7, ''], denyKeys: ['n'] }],
      approveKeys: ['1'],
      denyKeys: [42],
    }),
  );
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('claude');
  expect(m.rules[0]!.approveKeys).toEqual(['y']); // non-strings dropped
  expect(m.rules[0]!.denyKeys).toEqual(['n']);
  expect(m.approveKeys).toEqual(['1']);
  expect(m.denyKeys).toBeUndefined(); // all-junk array -> absent
});

// 4. Malformed override -> built-in + warn (must never throw). Two variants.
test('a malformed-JSON override is ignored: built-in used, warning emitted, no throw', () => {
  const cfg = writeOverride('claude', '{ this is not valid json ]');
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('claude');
  expect(m).toBe(CLAUDE_MANIFEST); // exact built-in object, by reference
  expect(stderrSpy).toHaveBeenCalled();
});

test('a schema-invalid override (rules not an array) is ignored: built-in used, warning emitted', () => {
  const cfg = writeOverride('claude', JSON.stringify({ agent: 'claude', rules: { nope: true } }));
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('claude');
  expect(m).toBe(CLAUDE_MANIFEST);
  expect(stderrSpy).toHaveBeenCalled();
});

// 5. Bad-regex rule -> dropped (once, at load) + warn; sibling rules survive.
test('an invalid-regex rule is dropped with a single warning; the good rule survives', () => {
  const cfg = writeOverride(
    'claude',
    JSON.stringify({
      agent: 'claude',
      linesFromBottom: 15,
      promptMarker: '❯',
      rules: [
        { id: 'bad', pattern: '(', state: 'BUSY' }, // unbalanced paren -> RegExp throws
        { id: 'good', pattern: 'HELLO', state: 'QUESTION' },
      ],
    }),
  );
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('claude');
  expect(m.rules.map((r) => r.id)).toEqual(['good']); // bad dropped, good kept
  expect(stderrSpy).toHaveBeenCalledTimes(1); // one warn, at load — not once per scrape
  // Scraping again does not re-warn (regex is cached) and the good rule fires.
  expect(detectFromPaneContent(['say HELLO now'], m)).toEqual({ status: AgentStatus.QUESTION, ruleId: 'good' });
  expect(stderrSpy).toHaveBeenCalledTimes(1);
});

// 6. linesFromBottom bounds the rule-match window.
test('linesFromBottom bounds the rule-match window', () => {
  const m: DetectionManifest = {
    agent: 't',
    linesFromBottom: 5,
    promptMarker: '',
    rules: [{ id: 'hit', pattern: 'NEEDLE', state: 'BUSY' }],
  };
  const above = ['NEEDLE', ...Array.from({ length: 19 }, () => 'x')]; // NEEDLE at the top of 20 lines
  expect(detectFromPaneContent(above, m).status).toBeNull(); // outside the 5-line window
  const inside = [...Array.from({ length: 19 }, () => 'x'), 'NEEDLE']; // NEEDLE at the bottom
  expect(detectFromPaneContent(inside, m)).toEqual({ status: AgentStatus.BUSY, ruleId: 'hit' });
});

// 7. Prompt-marker fallback, including the intentional full-buffer scan quirk.
test('prompt-marker fallback: present => IDLE, absent => null, above-window still IDLE', () => {
  const m: DetectionManifest = { agent: 't', linesFromBottom: 5, promptMarker: '❯', rules: [] };
  // Marker in the bottom window.
  expect(detectFromPaneContent(['work', '❯'], m)).toEqual({ status: AgentStatus.IDLE, ruleId: 'idle.prompt' });
  // Marker absent entirely.
  expect(detectFromPaneContent(['just some text'], m).status).toBeNull();
  // Marker present only ABOVE linesFromBottom — still IDLE (marker scan spans the
  // full buffer, unlike the windowed rule match; a preserved pre-Phase-2 quirk).
  const deep = ['❯', ...Array.from({ length: 19 }, () => 'scrollback')];
  expect(detectFromPaneContent(deep, m)).toEqual({ status: AgentStatus.IDLE, ruleId: 'idle.prompt' });
});

// 8. Lingering-prompt fix: the live-only BUSY rules (token counter,
//    esc-to-interrupt) precede PERMIT/QUESTION, so an ANSWERED prompt still
//    visible in the bottom window while a turn runs reads BUSY — not a false
//    "waiting" that the engine's trust-scrape-PERMIT-absolutely rule would
//    surface over the hook's BUSY. A GENUINE dialog suspends the counter and the
//    esc hint (see the claude-blocked fixture shape below), so real prompts are
//    unaffected. Matches herdr/agent-radar's working-beats-blocked priority for
//    claude.
describe('claude: live working indicators outrank a lingering answered prompt', () => {
  test('answered "Do you want to proceed?" + ticking token counter reads BUSY', () => {
    // Frame shape from a real captured claude working screen, with the
    // answered dialog text still inside the bottom-15 window.
    const lines = ['│ Do you want to proceed?', '│ ❯ 1. Yes', '', '✽ Processing… (20m 29s · ↓ 45.4k tokens)', '', '❯'];
    expect(detectFromPaneContent(lines, CLAUDE_MANIFEST)).toEqual({
      status: AgentStatus.BUSY,
      ruleId: 'busy.token-counter-min',
    });
  });

  test('lingering [y/n] + esc-to-interrupt hint reads BUSY', () => {
    const lines = ['Allow Edit to /path/file.ts?', '[y/n]', '', '✻ Cranking… (esc to interrupt)', '❯'];
    expect(detectFromPaneContent(lines, CLAUDE_MANIFEST)).toEqual({
      status: AgentStatus.BUSY,
      ruleId: 'busy.esc-interrupt',
    });
  });

  test('a genuine open dialog (counter and esc hint suspended) still reads PERMIT', () => {
    // Bottom of the real claude-blocked fixture: the dialog replaces the status
    // line, so no BUSY rule can shadow it.
    const lines = [
      '⏺ Bash(rm -rf node_modules && npm install)',
      '  ⎿  Running…',
      '',
      '│ Do you want to proceed?',
      '│ ❯ 1. Yes',
      '│   2. No, and tell Claude what to do differently (esc)',
    ];
    expect(detectFromPaneContent(lines, CLAUDE_MANIFEST)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.do-you-want',
    });
  });

  test('a genuine question dialog still reads QUESTION', () => {
    const lines = ['1. Option A', '2. Option B', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
    expect(detectFromPaneContent(lines, CLAUDE_MANIFEST)).toEqual({
      status: AgentStatus.QUESTION,
      ruleId: 'question.enter-select',
    });
  });
});

// 8b. Field-tested Claude Code permission-dialog phrases (herdr/tmux-agents-mon
//     agents/claude.conf BLOCKED_SCREEN) added as case-insensitive PERMIT rules
//     in tier 2. Each phrase alone reads PERMIT; a live token counter alongside
//     a lingering answered one of these prompts still reads BUSY (tier 1 wins).
describe('claude: field-tested permit phrases', () => {
  const cases: Array<{ name: string; lines: string[]; ruleId: string }> = [
    { name: 'waiting for permission', lines: ['waiting for permission'], ruleId: 'permit.waiting-for-permission' },
    {
      name: 'do you want to allow this connection?',
      lines: ['do you want to allow this connection?'],
      ruleId: 'permit.allow-connection',
    },
    { name: 'tab to amend', lines: ['tab to amend'], ruleId: 'permit.tab-to-amend' },
    { name: 'ctrl+e to explain', lines: ['ctrl+e to explain'], ruleId: 'permit.ctrl-e-explain' },
    { name: 'run a dynamic workflow?', lines: ['run a dynamic workflow?'], ruleId: 'permit.dynamic-workflow' },
  ];
  for (const c of cases) {
    test(`${c.name} → PERMIT via ${c.ruleId}`, () => {
      expect(detectFromPaneContent([...c.lines, '❯'], CLAUDE_MANIFEST)).toEqual({
        status: AgentStatus.PERMIT,
        ruleId: c.ruleId,
      });
    });
  }

  test('a live token counter outranks a lingering answered "waiting for permission" prompt', () => {
    const lines = ['│ waiting for permission', '│ ❯ 1. Yes', '', '✽ Processing… (20m 29s · ↓ 45.4k tokens)', '', '❯'];
    expect(detectFromPaneContent(lines, CLAUDE_MANIFEST)).toEqual({
      status: AgentStatus.BUSY,
      ruleId: 'busy.token-counter-min',
    });
  });
});

// 9. The opencode built-in, verified against real captured opencode frames
//    (herdr/agent-radar-derived patterns). Previously a hook-less opencode could
//    only ever read BUSY/IDLE from the glyph scan.
describe('OPENCODE_MANIFEST classifies real opencode frames', () => {
  test('permission dialog reads PERMIT via the △ marker (first match)', () => {
    const lines = [
      '│  Write src/index.ts',
      '',
      '△ Permission required',
      '',
      '  Allow opencode to write to src/index.ts?',
      '',
      '  ↑↓ select · enter confirm · esc dismiss',
    ];
    expect(detectFromPaneContent(lines, OPENCODE_MANIFEST)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.required',
    });
  });

  test('confirm/dismiss hint line alone reads PERMIT (dialog scrolled past the △)', () => {
    const lines = ['  ↑↓ select · enter confirm · esc dismiss'];
    expect(detectFromPaneContent(lines, OPENCODE_MANIFEST)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.dismiss-confirm',
    });
  });

  test('working frame reads BUSY via the interrupt hint', () => {
    const lines = ['│ Analyzing the codebase structure', '', '■■■■■■⬝⬝⬝⬝⬝⬝', '', 'working · esc to interrupt'];
    expect(detectFromPaneContent(lines, OPENCODE_MANIFEST)).toEqual({
      status: AgentStatus.BUSY,
      ruleId: 'busy.esc-interrupt',
    });
  });

  test('the animated progress bar alone reads BUSY', () => {
    expect(detectFromPaneContent(['■■■■■■⬝⬝⬝⬝⬝⬝'], OPENCODE_MANIFEST)).toEqual({
      status: AgentStatus.BUSY,
      ruleId: 'busy.progress-bar',
    });
  });

  test('fewer than four bar characters is not a progress bar', () => {
    expect(detectFromPaneContent(['■■■ partial'], OPENCODE_MANIFEST).status).toBeNull();
  });

  test('permission dialog outranks a co-present working hint (upstream blocked-before-working order)', () => {
    const lines = ['△ Permission required', 'working · esc to interrupt'];
    expect(detectFromPaneContent(lines, OPENCODE_MANIFEST).status).toBe(AgentStatus.PERMIT);
  });

  test('no promptMarker: an unrecognized frame stays null, never guesses IDLE', () => {
    expect(detectFromPaneContent(['$ ls', 'src  README.md'], OPENCODE_MANIFEST)).toEqual({
      status: null,
      ruleId: null,
    });
  });

  test("loadDetectionManifest('opencode') resolves the built-in", () => {
    expect(loadDetectionManifest('opencode')).toBe(OPENCODE_MANIFEST);
  });
});

// 10. titleRules ride the same override/validation path as screen rules: an
//     override may add them, bad-regex title rules are dropped at load, and a
//     manifest without them simply never title-matches.
describe('titleRules in overrides', () => {
  test('an override can supply titleRules; a bad-regex title rule is dropped, siblings survive', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        agent: 'claude',
        linesFromBottom: 15,
        promptMarker: '❯',
        rules: [],
        titleRules: [
          { id: 'bad', pattern: '(', state: 'BUSY' },
          { id: 'permit.title-custom', pattern: '^WAITING:', state: 'PERMIT' },
        ],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect((m.titleRules ?? []).map((r) => r.id)).toEqual(['permit.title-custom']);
    expect(detectFromTitle('WAITING: approve the deploy', m)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.title-custom',
    });
    expect(detectFromTitle('all quiet', m)).toEqual({ status: null, ruleId: null });
  });

  test('an override without titleRules leaves them absent (title never matches)', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({ agent: 'claude', linesFromBottom: 15, promptMarker: '❯', rules: [] }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.titleRules).toBeUndefined();
    expect(detectFromTitle('⠂ working away', m).status).toBeNull();
  });
});

// 11. Unknown agent (no built-in, no override) -> empty manifest, safe null result.
test('an unknown agent with no override yields an empty manifest and warns', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'fleet-detect-empty-'));
  tempDirs.push(cfg);
  process.env.XDG_CONFIG_HOME = cfg;
  __resetManifestCache();

  const m = loadDetectionManifest('does-not-exist');
  expect(m.rules).toEqual([]);
  expect(m.promptMarker).toBe('');
  expect(stderrSpy).toHaveBeenCalled();
  // Even with content the built-in would recognize, an empty manifest detects nothing.
  expect(detectFromPaneContent(['[y/n]', '❯'], m)).toEqual({ status: null, ruleId: null });
});

// 12. schemaVersion:1 override envelopes — explicit built-in inheritance.
//     A legacy (no-schema) override still replaces wholesale (tested above); an
//     envelope inherits a built-in and applies stable-id operations on top.
describe('schemaVersion:1 override envelopes', () => {
  test('appendRules adds to the built-in and preserves first-match ordering', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        appendRules: [{ id: 'permit.custom-tool', pattern: 'approve MyTool\\?', flags: 'i', state: 'PERMIT' }],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    // Built-in rules survive, appended rule lands at the end.
    expect(m.rules.map((r) => r.id)).toContain('permit.yn');
    expect(m.rules.at(-1)!.id).toBe('permit.custom-tool');
    // Built-in permit still fires (first match wins on its own frame).
    expect(detectFromPaneContent(['Allow Edit? [y/n]'], m)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.yn',
    });
    // Appended rule fires on its own frame.
    expect(detectFromPaneContent(['approve MyTool?'], m).ruleId).toBe('permit.custom-tool');
  });

  test('replaceRules swaps a rule in place by id, keeping its position', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        replaceRules: [{ id: 'permit.yn', pattern: 'YESNO', state: 'QUESTION' }],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    const idx = m.rules.findIndex((r) => r.id === 'permit.yn');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Same id, same slot, new pattern + state.
    expect(m.rules[idx]!.state).toBe('QUESTION');
    expect(detectFromPaneContent(['YESNO'], m)).toEqual({ status: AgentStatus.QUESTION, ruleId: 'permit.yn' });
    // Old [y/n] pattern no longer classified by that rule.
    expect(detectFromPaneContent(['Allow Edit? [y/n]'], m).ruleId).not.toBe('permit.yn');
  });

  test('disableRules removes a built-in rule by id', () => {
    const cfg = writeOverride('claude', JSON.stringify({ schemaVersion: 1, disableRules: ['permit.yn'] }));
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.rules.some((r) => r.id === 'permit.yn')).toBe(false);
    // Other built-in permit rules remain.
    expect(m.rules.some((r) => r.id === 'permit.do-you-want')).toBe(true);
  });

  test('title rule operations mirror the screen-rule operations', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        disableTitleRules: ['busy.title-spinner'],
        appendTitleRules: [{ id: 'permit.title-blocked', pattern: 'Needs Input', state: 'PERMIT' }],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.titleRules!.map((r) => r.id)).toEqual(['permit.title-blocked']);
    expect(detectFromTitle('Needs Input now', m)).toEqual({
      status: AgentStatus.PERMIT,
      ruleId: 'permit.title-blocked',
    });
  });

  test('scalar overrides layer on top of the inherited built-in', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({ schemaVersion: 1, linesFromBottom: 3, promptMarker: '$$', approveKeys: ['z'] }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.linesFromBottom).toBe(3);
    expect(m.promptMarker).toBe('$$');
    expect(m.approveKeys).toEqual(['z']);
    // A scalar not supplied keeps the built-in value.
    expect(m.denyKeys).toEqual(CLAUDE_MANIFEST.denyKeys);
    // Rules are unchanged from the built-in.
    expect(m.rules.map((r) => r.id)).toEqual(CLAUDE_MANIFEST.rules.map((r) => r.id));
  });

  test('extends inherits a DIFFERENT built-in', () => {
    const cfg = writeOverride('pi', JSON.stringify({ schemaVersion: 1, extends: 'claude' }));
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('pi');
    expect(m.agent).toBe('pi');
    // Inherited claude's rules.
    expect(m.rules.map((r) => r.id)).toEqual(CLAUDE_MANIFEST.rules.map((r) => r.id));
  });

  test('an unknown schemaVersion warns and falls back to the built-in', () => {
    const cfg = writeOverride('claude', JSON.stringify({ schemaVersion: 99, disableRules: ['permit.yn'] }));
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m).toBe(CLAUDE_MANIFEST); // exact built-in, operations ignored
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('an unknown extends warns and inherits the agent\u2019s own built-in', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({ schemaVersion: 1, extends: 'nope', disableRules: ['permit.yn'] }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    // Fell back to claude's own built-in as the base, still applied the op.
    expect(m.rules.some((r) => r.id === 'permit.yn')).toBe(false);
    expect(m.rules.some((r) => r.id === 'permit.do-you-want')).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('replaceRules targeting a missing id warns and is ignored', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({ schemaVersion: 1, replaceRules: [{ id: 'no.such.rule', pattern: 'X', state: 'BUSY' }] }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.rules.some((r) => r.id === 'no.such.rule')).toBe(false);
    expect(m.rules.map((r) => r.id)).toEqual(CLAUDE_MANIFEST.rules.map((r) => r.id));
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('an appended rule with a duplicate id is dropped (first-match kept)', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({ schemaVersion: 1, appendRules: [{ id: 'permit.yn', pattern: 'DUP', state: 'BUSY' }] }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    // Only one permit.yn, the original built-in one (its position preserved).
    expect(m.rules.filter((r) => r.id === 'permit.yn')).toHaveLength(1);
    expect(m.rules.find((r) => r.id === 'permit.yn')!.state).toBe('PERMIT');
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('stateful global/sticky regex flags are rejected', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        appendRules: [
          { id: 'unsafe.global', pattern: 'HELLO', flags: 'gi', state: 'BUSY' },
          { id: 'safe.casefold', pattern: 'WORLD', flags: 'i', state: 'BUSY' },
        ],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.rules.some((r) => r.id === 'unsafe.global')).toBe(false);
    expect(m.rules.some((r) => r.id === 'safe.casefold')).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('control characters in ids and oversized patterns are rejected', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        appendRules: [
          { id: 'bad\nrow', pattern: 'HELLO', state: 'BUSY' },
          { id: 'too.long', pattern: 'x'.repeat(1025), state: 'BUSY' },
        ],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.rules.some((r) => r.id === 'bad\nrow')).toBe(false);
    expect(m.rules.some((r) => r.id === 'too.long')).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('an envelope with a bad-regex appended rule drops only that rule', () => {
    const cfg = writeOverride(
      'claude',
      JSON.stringify({
        schemaVersion: 1,
        appendRules: [
          { id: 'bad', pattern: '(', state: 'BUSY' },
          { id: 'good', pattern: 'HELLO', state: 'QUESTION' },
        ],
      }),
    );
    process.env.XDG_CONFIG_HOME = cfg;
    __resetManifestCache();

    const m = loadDetectionManifest('claude');
    expect(m.rules.some((r) => r.id === 'bad')).toBe(false);
    expect(m.rules.some((r) => r.id === 'good')).toBe(true);
  });
});
