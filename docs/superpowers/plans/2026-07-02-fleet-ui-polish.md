# Fleet UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adaptive light/dark theming, a width-responsive card/sidebar layout, richer state signaling (summary strip, hover, scroll indicators, busy pulse, distinct empty states), and tmux sidebar/popup install bindings — per `docs/superpowers/specs/2026-07-02-fleet-ui-polish-design.md`.

**Architecture:** All changes ride the existing pipeline: state engine → `TuiApp` row model → pure render functions → one string per frame. New pure modules (`theme.ts`, `layouts/`, hit-test mapping) keep logic unit-testable; `index.ts` gains only thin wiring. Theme detection runs once at startup through a signal chain proven by live spike (2026-07-02, tmux 3.7a + Ghostty 1.3.1): OSC 11 does NOT round-trip inside tmux, `COLORFGBG` is unset, macOS `AppleInterfaceStyle` works.

**Tech Stack:** Bun + TypeScript strict (`noUncheckedIndexedAccess`), zero runtime deps, `bun test`, oxlint/oxfmt.

## Global Constraints

- Zero runtime dependencies; no new packages ever.
- Subprocesses only via `Bun.spawnSync` with argv **arrays** (the `src/tmux/ipc.ts` pattern). Never `exec()`/shell-string interpolation — command injection is structurally impossible with argv arrays.
- Tests collocated as `*.test.ts`; run `bun test && bun run typecheck && bun run lint && bun run format` before every commit — all must pass.
- **`process.stdout.isTTY` is false under `bun test`, so every `C.*` getter returns `''` in tests.** Assert on plain text and on exported palette data (`stateRgb`), never on escape codes via `C`.
- No new timers — animation rides the existing 500ms `FAST_REFRESH_MS` tick.
- Fleet never paints background colors; all styling is foreground-only.
- Plain Unicode glyphs only (no nerd fonts). `NO_COLOR`/non-TTY behavior unchanged.
- Conventional commits (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`), committed on branch `feat/ui-polish`.
- Existing baseline: 222 tests green. Never commit with fewer passing than you started with.

---

### Task 1: Theme decision logic (pure)

**Files:**
- Create: `src/terminal/theme.ts`
- Test: `src/terminal/theme.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `type ThemeMode = 'light' | 'dark'`, `interface Rgb {r,g,b: number}`, `parseOsc11Reply(data: Buffer): Rgb | null`, `stripOsc11Reply(data: Buffer): Buffer`, `luminance(c: Rgb): number`, `modeFromBackground(c: Rgb): ThemeMode`, `modeFromColorFgBg(value: string): ThemeMode | null`, `interface ThemeSignals`, `resolveThemeMode(s: ThemeSignals): ThemeMode`. Tasks 2–3 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

```ts
// src/terminal/theme.test.ts
import { describe, expect, test } from 'bun:test';
import {
  luminance,
  modeFromBackground,
  modeFromColorFgBg,
  parseOsc11Reply,
  resolveThemeMode,
  stripOsc11Reply,
  type ThemeSignals,
} from './theme.ts';

const signals = (over: Partial<ThemeSignals>): ThemeSignals => ({
  envTheme: undefined,
  tmuxOption: null,
  oscBackground: null,
  colorFgBg: undefined,
  macAppearance: null,
  ...over,
});

describe('parseOsc11Reply', () => {
  test('parses 4-digit reply with BEL terminator', () => {
    const buf = Buffer.from('\x1b]11;rgb:1e1e/2e2e/3e3e\x07', 'latin1');
    expect(parseOsc11Reply(buf)).toEqual({ r: 30, g: 46, b: 62 });
  });
  test('parses 2-digit reply with ST terminator', () => {
    const buf = Buffer.from('\x1b]11;rgb:ff/ff/ff\x1b\\', 'latin1');
    expect(parseOsc11Reply(buf)).toEqual({ r: 255, g: 255, b: 255 });
  });
  test('returns null for incomplete reply (split read)', () => {
    expect(parseOsc11Reply(Buffer.from('\x1b]11;rgb:1e1e/2e', 'latin1'))).toBeNull();
  });
  test('returns null for unrelated input', () => {
    expect(parseOsc11Reply(Buffer.from('jjq', 'latin1'))).toBeNull();
  });
  test('finds reply even with keystrokes around it', () => {
    const buf = Buffer.from('j\x1b]11;rgb:0000/0000/0000\x07k', 'latin1');
    expect(parseOsc11Reply(buf)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('stripOsc11Reply', () => {
  test('removes the reply, keeps surrounding keystrokes', () => {
    const buf = Buffer.from('j\x1b]11;rgb:1e1e/2e2e/3e3e\x07k', 'latin1');
    expect(stripOsc11Reply(buf).toString('latin1')).toBe('jk');
  });
  test('passes through buffers with no reply', () => {
    expect(stripOsc11Reply(Buffer.from('abc')).toString()).toBe('abc');
  });
});

describe('luminance / modeFromBackground', () => {
  test('black is dark', () => {
    expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(modeFromBackground({ r: 0, g: 0, b: 0 })).toBe('dark');
  });
  test('white is light', () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1);
    expect(modeFromBackground({ r: 255, g: 255, b: 255 })).toBe('light');
  });
  test('catppuccin mocha base (#1e1e2e) is dark', () => {
    expect(modeFromBackground({ r: 30, g: 30, b: 46 })).toBe('dark');
  });
});

describe('modeFromColorFgBg', () => {
  test('"15;0" is dark', () => expect(modeFromColorFgBg('15;0')).toBe('dark'));
  test('"0;15" is light', () => expect(modeFromColorFgBg('0;15')).toBe('light'));
  test('"0;default;7" is light (bg 7 = light gray)', () => expect(modeFromColorFgBg('0;default;7')).toBe('light'));
  test('"15;8" is dark (bg 8 = dark gray)', () => expect(modeFromColorFgBg('15;8')).toBe('dark'));
  test('junk is null', () => expect(modeFromColorFgBg('banana')).toBeNull());
});

describe('resolveThemeMode precedence', () => {
  test('defaults to dark with no signals', () => {
    expect(resolveThemeMode(signals({}))).toBe('dark');
  });
  test('FLEET_THEME env beats everything', () => {
    expect(resolveThemeMode(signals({ envTheme: 'light', tmuxOption: 'dark', macAppearance: 'Dark' }))).toBe('light');
  });
  test('invalid env value is ignored', () => {
    expect(resolveThemeMode(signals({ envTheme: 'solarized' }))).toBe('dark');
  });
  test('tmux @fleet-theme beats detection', () => {
    expect(resolveThemeMode(signals({ tmuxOption: 'light', oscBackground: { r: 0, g: 0, b: 0 } }))).toBe('light');
  });
  test('OSC background beats COLORFGBG and macOS', () => {
    expect(
      resolveThemeMode(signals({ oscBackground: { r: 255, g: 255, b: 255 }, colorFgBg: '15;0', macAppearance: 'Dark' })),
    ).toBe('light');
  });
  test('COLORFGBG beats macOS appearance', () => {
    expect(resolveThemeMode(signals({ colorFgBg: '0;15', macAppearance: 'Dark' }))).toBe('light');
  });
  test('macOS appearance is the last auto rung', () => {
    expect(resolveThemeMode(signals({ macAppearance: 'Light' }))).toBe('light');
    expect(resolveThemeMode(signals({ macAppearance: 'Dark' }))).toBe('dark');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/terminal/theme.test.ts`
Expected: FAIL — `Cannot find module './theme.ts'`

- [ ] **Step 3: Implement the module**

```ts
// src/terminal/theme.ts
export type ThemeMode = 'light' | 'dark';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// OSC 11 reply: ESC ] 11 ; rgb:RRRR/GGGG/BBBB terminated by BEL or ST (ESC \).
// Component width varies by terminal (1–4 hex digits); scale each to 0–255.
// oxlint-disable-next-line no-control-regex
const OSC11_REPLY = /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)/;

export function parseOsc11Reply(data: Buffer): Rgb | null {
  const m = OSC11_REPLY.exec(data.toString('latin1'));
  if (!m) return null;
  const scale = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return { r: scale(m[1]!), g: scale(m[2]!), b: scale(m[3]!) };
}

// Remove the OSC reply from a stdin buffer so real keystrokes typed during the
// detection window can be replayed to the normal input path.
export function stripOsc11Reply(data: Buffer): Buffer {
  return Buffer.from(data.toString('latin1').replace(OSC11_REPLY, ''), 'latin1');
}

// Rec.709 relative luminance, normalized 0–1.
export function luminance(c: Rgb): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

export function modeFromBackground(c: Rgb): ThemeMode {
  return luminance(c) < 0.5 ? 'dark' : 'light';
}

// COLORFGBG is "fg;bg" (some terminals: "fg;default;bg"). ANSI bg 0–6 and 8
// are dark; 7 (light gray) and 9–15 are light.
export function modeFromColorFgBg(value: string): ThemeMode | null {
  const parts = value.split(';');
  const bg = parseInt(parts[parts.length - 1] ?? '', 10);
  if (Number.isNaN(bg)) return null;
  return bg <= 6 || bg === 8 ? 'dark' : 'light';
}

export interface ThemeSignals {
  envTheme: string | undefined; // FLEET_THEME
  tmuxOption: string | null; // tmux @fleet-theme user option
  oscBackground: Rgb | null; // parsed OSC 11 reply
  colorFgBg: string | undefined; // COLORFGBG env
  macAppearance: 'Dark' | 'Light' | null; // AppleInterfaceStyle; null off-macOS
}

// First hit wins: explicit overrides, then measured signals, then default.
export function resolveThemeMode(s: ThemeSignals): ThemeMode {
  if (s.envTheme === 'light' || s.envTheme === 'dark') return s.envTheme;
  if (s.tmuxOption === 'light' || s.tmuxOption === 'dark') return s.tmuxOption;
  if (s.oscBackground) return modeFromBackground(s.oscBackground);
  if (s.colorFgBg !== undefined) {
    const m = modeFromColorFgBg(s.colorFgBg);
    if (m) return m;
  }
  if (s.macAppearance) return s.macAppearance === 'Dark' ? 'dark' : 'light';
  return 'dark';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/terminal/theme.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Verify and commit**

```bash
bun test && bun run typecheck && bun run lint && bun run format
git add src/terminal/theme.ts src/terminal/theme.test.ts
git commit -m "feat: add pure theme detection logic (OSC 11 parse, luminance, precedence)"
```

---

### Task 2: Light/dark state palettes in colors.ts

**Files:**
- Modify: `src/terminal/colors.ts`
- Test: `src/terminal/colors.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ThemeMode` from `./theme.ts` (Task 1).
- Produces: `setThemeMode(mode: ThemeMode): void`, `getThemeMode(): ThemeMode`, `stateRgb(key: StateColorKey): readonly [number, number, number]`, `type StateColorKey`. The `C` object keeps its exact shape (all existing getters) and gains `C.underline`. Tasks 3, 4, 7, 8 rely on these.

- [ ] **Step 1: Write the failing tests** (append to `src/terminal/colors.test.ts`; keep existing tests untouched)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { getThemeMode, setThemeMode, stateRgb } from './colors.ts';

describe('theme palettes', () => {
  afterEach(() => setThemeMode('dark'));

  test('defaults to dark (Catppuccin Mocha)', () => {
    expect(getThemeMode()).toBe('dark');
    expect(stateRgb('permit')).toEqual([249, 226, 175]);
    expect(stateRgb('idle')).toEqual([137, 180, 250]);
  });

  test('light mode swaps to Catppuccin Latte', () => {
    setThemeMode('light');
    expect(getThemeMode()).toBe('light');
    expect(stateRgb('permit')).toEqual([223, 142, 29]);
    expect(stateRgb('question')).toEqual([136, 57, 239]);
    expect(stateRgb('done')).toEqual([64, 160, 43]);
    expect(stateRgb('busy')).toEqual([254, 100, 11]);
    expect(stateRgb('idle')).toEqual([30, 102, 245]);
    expect(stateRgb('shell')).toEqual([156, 160, 176]);
    expect(stateRgb('down')).toEqual([188, 192, 204]);
  });

  test('switching back restores Mocha', () => {
    setThemeMode('light');
    setThemeMode('dark');
    expect(stateRgb('done')).toEqual([166, 227, 161]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/terminal/colors.test.ts`
Expected: FAIL — `setThemeMode` not exported

- [ ] **Step 3: Rework the palette block in `src/terminal/colors.ts`**

Replace the `// Catppuccin Mocha palette for state colors` getters block (currently lines 61–83) and add above `export const C`:

```ts
import type { ThemeMode } from './theme.ts';

export type StateColorKey = 'permit' | 'question' | 'done' | 'busy' | 'idle' | 'shell' | 'down';

type StatePalette = Record<StateColorKey, readonly [number, number, number]>;

// Catppuccin Mocha (dark terminals): yellow, mauve, green, peach, blue, overlay0, surface1
const MOCHA: StatePalette = {
  permit: [249, 226, 175],
  question: [203, 166, 247],
  done: [166, 227, 161],
  busy: [250, 179, 135],
  idle: [137, 180, 250],
  shell: [108, 112, 134],
  down: [69, 71, 90],
};

// Catppuccin Latte (light terminals): same roles, legible on white
const LATTE: StatePalette = {
  permit: [223, 142, 29],
  question: [136, 57, 239],
  done: [64, 160, 43],
  busy: [254, 100, 11],
  idle: [30, 102, 245],
  shell: [156, 160, 176],
  down: [188, 192, 204],
};

let activePalette: StatePalette = MOCHA;

export function setThemeMode(mode: ThemeMode): void {
  activePalette = mode === 'light' ? LATTE : MOCHA;
}

export function getThemeMode(): ThemeMode {
  return activePalette === LATTE ? 'light' : 'dark';
}

export function stateRgb(key: StateColorKey): readonly [number, number, number] {
  return activePalette[key];
}
```

Inside `C`, replace the seven state getters with palette-routed versions and add `underline`:

```ts
  get underline() {
    return code('\x1b[4m');
  },
  // State colors route through the active palette (Mocha/Latte per theme).
  get permit() {
    return rgb(...activePalette.permit);
  },
  get question() {
    return rgb(...activePalette.question);
  },
  get done() {
    return rgb(...activePalette.done);
  },
  get busy() {
    return rgb(...activePalette.busy);
  },
  get idle() {
    return rgb(...activePalette.idle);
  },
  get shell() {
    return rgb(...activePalette.shell);
  },
  get down() {
    return rgb(...activePalette.down);
  },
```

(`rgb(...)` already exists; chrome getters — `gray`, `dim`, `bold`, named ANSI — stay untouched: named codes adapt via the terminal palette by construction.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/terminal/colors.test.ts`
Expected: PASS, including all pre-existing cases

- [ ] **Step 5: Verify and commit**

```bash
bun test && bun run typecheck && bun run lint && bun run format
git add src/terminal/colors.ts src/terminal/colors.test.ts
git commit -m "feat: add Latte light palette behind setThemeMode"
```

---

### Task 3: Theme detection I/O + startup wiring

**Files:**
- Modify: `src/terminal/theme.ts` (append I/O section)
- Modify: `index.ts:529-546` (`launchTui` startup) and `index.ts:796-800` (stdin attach)
- Modify: `index.ts:46-93` (`printHelp` — drop hardcoded RGB literals, use `C`)
- Test: `src/terminal/theme.test.ts` (stripOsc11Reply already covers the pure seam; I/O verified manually)

**Interfaces:**
- Consumes: Task 1 pure functions, Task 2 `setThemeMode`.
- Produces: `detectThemeMode(): Promise<{ mode: ThemeMode; leftover: Buffer }>`, `readTmuxThemeOption(): string | null`, `readMacAppearance(): 'Dark' | 'Light' | null`, `queryOscBackground(timeoutMs?: number): Promise<{ background: Rgb | null; leftover: Buffer }>`.

- [ ] **Step 1: Append the I/O section to `src/terminal/theme.ts`**

All subprocesses below use `Bun.spawnSync` with argv arrays — no shell is ever involved.

```ts
// ---- I/O section: reads env/tmux/OS and performs the OSC 11 round-trip ----

export function readTmuxThemeOption(): string | null {
  try {
    const p = Bun.spawnSync({ cmd: ['tmux', 'show', '-gqv', '@fleet-theme'], stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) return null;
    const v = p.stdout.toString().trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function readMacAppearance(): 'Dark' | 'Light' | null {
  if (process.platform !== 'darwin') return null;
  try {
    const p = Bun.spawnSync({ cmd: ['defaults', 'read', '-g', 'AppleInterfaceStyle'], stdout: 'pipe', stderr: 'pipe' });
    // Key absent (non-zero exit) means the system is in light mode.
    if (p.exitCode !== 0) return 'Light';
    return p.stdout.toString().trim() === 'Dark' ? 'Dark' : 'Light';
  } catch {
    return null;
  }
}

const OSC11_QUERY = '\x1b]11;?\x07';
const OSC11_TIMEOUT_MS = 150;

// Query the terminal background. Requires raw mode and must run BEFORE the
// main input listener attaches. Collects stdin during the window; returns the
// parsed reply (if any) plus all non-reply bytes for the caller to replay.
// Spike-verified: tmux 3.7a never answers — the timeout path is the normal
// path inside tmux today; the reply path serves outside-tmux runs.
export function queryOscBackground(
  timeoutMs = OSC11_TIMEOUT_MS,
): Promise<{ background: Rgb | null; leftover: Buffer }> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve({ background: null, leftover: Buffer.alloc(0) });
      return;
    }
    const chunks: Buffer[] = [];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      const all = Buffer.concat(chunks);
      resolve({ background: parseOsc11Reply(all), leftover: stripOsc11Reply(all) });
    };
    const onData = (c: Buffer) => {
      chunks.push(c);
      // Complete reply seen — no need to wait out the timer.
      if (parseOsc11Reply(Buffer.concat(chunks))) done();
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', onData);
    process.stdout.write(OSC11_QUERY);
  });
}

export async function detectThemeMode(): Promise<{ mode: ThemeMode; leftover: Buffer }> {
  const envTheme = Bun.env.FLEET_THEME;
  const tmuxOption = readTmuxThemeOption();
  // An explicit override decides immediately — skip the 150ms OSC wait.
  if (envTheme === 'light' || envTheme === 'dark' || tmuxOption === 'light' || tmuxOption === 'dark') {
    const mode = resolveThemeMode({ envTheme, tmuxOption, oscBackground: null, colorFgBg: undefined, macAppearance: null });
    return { mode, leftover: Buffer.alloc(0) };
  }
  const { background, leftover } = await queryOscBackground();
  const mode = resolveThemeMode({
    envTheme,
    tmuxOption,
    oscBackground: background,
    colorFgBg: Bun.env.COLORFGBG,
    macAppearance: readMacAppearance(),
  });
  return { mode, leftover };
}
```

- [ ] **Step 2: Wire into `launchTui` in `index.ts`**

Add imports: `import { detectThemeMode } from './src/terminal/theme.ts';` and add `setThemeMode` to the colors import. Replace the startup block (currently `index.ts:542-545`):

```ts
  // Raw mode first so the OSC 11 theme reply is readable from stdin, then the
  // rest of the terminal setup. Detection resolves in ≤150ms (0ms when an
  // explicit FLEET_THEME/@fleet-theme override is set).
  enterRawMode();
  const detectedTheme = await detectThemeMode();
  setThemeMode(detectedTheme.mode);
  enterAlternateScreen();
  hideCursor();
  enableMouse();
```

Immediately after the `process.stdin.on('data', ...)` registration (currently `index.ts:796-800`), replay any keystrokes swallowed during detection:

```ts
    if (detectedTheme.leftover.length > 0) {
      handleInput(detectedTheme.leftover);
      tick();
    }
```

- [ ] **Step 3: De-duplicate `printHelp` colors**

In `printHelp()` (`index.ts:46-93`), delete the local `permit/question/done/busy/idle` escape-string consts and the `c()` helper; replace each use with the matching `C` getter (`C.permit`, `C.question`, `C.done`, `C.busy`, `C.idle`, `C.bold`, `C.dim`, `C.gray`, `C.reset`). `C` already handles the non-TTY gate that `c()` reimplemented.

- [ ] **Step 4: Verify**

```bash
bun test && bun run typecheck && bun run lint && bun run format
```

Manual matrix (run each, confirm state colors legible and no stray bytes in the UI):

```bash
bun run dev                      # inside tmux on this Mac: AppleInterfaceStyle rung → follows system appearance
FLEET_THEME=light bun run dev    # forced Latte
FLEET_THEME=dark bun run dev     # forced Mocha
tmux set -g @fleet-theme light && bun run dev && tmux set -gu @fleet-theme   # tmux option rung
NO_COLOR=1 bun run dev           # still colorless
```

Also type a key immediately at launch — it must act normally (leftover replay).

- [ ] **Step 5: Commit**

```bash
git add index.ts src/terminal/theme.ts
git commit -m "feat: adaptive theme detection at startup (env, tmux option, OSC 11, COLORFGBG, macOS appearance)"
```

---

### Task 4: Distinct empty states

**Files:**
- Modify: `src/tmux/sessions.ts:15-36`
- Modify: `src/tui/app.ts` (two public flags)
- Modify: `src/tui/dashboard.ts:50-54`
- Modify: `index.ts` (`refreshStates`, `doRefresh`/`doFullRefresh`, launch)
- Test: `src/tui/dashboard.test.ts`

**Interfaces:**
- Consumes: `TuiApp`, `tmux()` from `src/tmux/ipc.ts`.
- Produces: `listPanesResult(): { ok: boolean; panes: PaneInfo[] }` in sessions.ts (existing `listPanes(): PaneInfo[]` becomes a thin wrapper and keeps all current callers working); `TuiApp.tmuxDown: boolean` and `TuiApp.hooksMissing: boolean` public fields. Task 8's hit-testing and Task 6's layouts treat these rows-empty branches as terminal.

- [ ] **Step 1: Write the failing tests** (append to `src/tui/dashboard.test.ts`, following its existing style of constructing a `TuiApp` and asserting on rendered strings)

```ts
describe('empty states', () => {
  test('tmux down explains itself instead of "No agents found"', () => {
    const app = new TuiApp();
    app.tmuxDown = true;
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain("tmux isn't running");
    expect(lines).not.toContain('No agents found');
  });

  test('missing hooks points at fleet install', () => {
    const app = new TuiApp();
    app.hooksMissing = true;
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('no agent hooks found');
    expect(lines).toContain('fleet install');
  });

  test('empty filter result names the filter', () => {
    const app = new TuiApp();
    app.setFilter('zzz');
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('no agents match');
  });

  test('genuinely idle fleet is all quiet', () => {
    const app = new TuiApp();
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('all quiet');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/dashboard.test.ts`
Expected: FAIL — `tmuxDown` does not exist on `TuiApp`

- [ ] **Step 3: Implement**

`src/tmux/sessions.ts` — split result from wrapper:

```ts
export interface ListPanesResult {
  ok: boolean;
  panes: PaneInfo[];
}

export function listPanesResult(): ListPanesResult {
  const result = tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (result.exitCode !== 0) return { ok: false, panes: [] };

  const panes: PaneInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const paneId = parts[0]!;
    panes.push({
      paneId,
      paneNum: parseInt(paneId.replace('%', ''), 10),
      sessionName: parts[1]!,
      windowName: parts[2]!,
      currentPath: parts[3]!,
      panePid: parseInt(parts[4]!, 10),
      paneTitle: parts[5]!,
    });
  }
  return { ok: true, panes };
}

export function listPanes(): PaneInfo[] {
  return listPanesResult().panes;
}
```

`src/tui/app.ts` — add next to `shouldQuit`:

```ts
  tmuxDown: boolean = false;
  hooksMissing: boolean = false;
```

`src/tui/dashboard.ts` — replace the `rows.length === 0` branch:

```ts
  if (rows.length === 0) {
    lines.push('');
    if (app.tmuxDown) {
      lines.push(`${C.permit}  ⚠ tmux isn't running${C.reset}`);
      lines.push(`${C.gray}  fleet reads agents from tmux panes — start tmux, then re-run fleet${C.reset}`);
    } else if (app.hooksMissing) {
      lines.push(`${C.question}  ? no agent hooks found${C.reset}`);
      lines.push(`${C.gray}  run ${C.reset}fleet install${C.gray} to wire Claude Code hooks, then ${C.reset}fleet doctor${C.gray} to verify${C.reset}`);
    } else if (app.isFiltering()) {
      lines.push(`${C.gray}  no agents match "${app.getFilter()}"${C.reset}`);
    } else {
      lines.push(`${C.idle}  ● all quiet${C.reset}`);
      lines.push(`${C.gray}  start claude in any tmux pane and it appears here${C.reset}`);
    }
    return lines;
  }
```

`index.ts` — in `refreshStates`, replace `const panes = listPanes();` with:

```ts
  const { ok: tmuxOk, panes } = listPanesResult();
  lastTmuxOk = tmuxOk;
```

Add module-level `let lastTmuxOk = true;` next to the caches (`index.ts:219`), import `listPanesResult` alongside `listPanes`. In `launchTui`, extend `doRefresh`/`doFullRefresh`:

```ts
  const doRefresh = () => {
    const states = refreshStates(statusDirs);
    app.updateStates(states);
    app.tmuxDown = !lastTmuxOk;
    app.hooksMissing = !statusDirs.some((d) => existsSync(d));
    needsRender = true;
  };
```

(same two lines in `doFullRefresh`; `fullRefreshStates` also calls `listPanes()` for the slow caches — switch it to `listPanesResult().panes`, otherwise untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: PASS (222 + new)

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/tmux/sessions.ts src/tui/app.ts src/tui/dashboard.ts index.ts src/tui/dashboard.test.ts
git commit -m "feat: distinct empty states for tmux-down, missing hooks, empty filter, and all-quiet"
```

---

### Task 5: Header summary strip

**Files:**
- Modify: `src/tui/dashboard.ts:31-44` (`renderHeader`)
- Test: `src/tui/dashboard.test.ts`

**Interfaces:**
- Consumes: `TuiApp.summary()` (`{total, permit, question, done, busy}`) and `TuiApp.shellCount()`.
- Produces: no new exports — `renderHeader(app, cols): string[]` signature unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
describe('header summary strip', () => {
  test('aggregates permit+question into "need you"', () => {
    const app = new TuiApp();
    app.updateStates([
      state({ paneId: '%1', status: AgentStatus.PERMIT }),
      state({ paneId: '%2', status: AgentStatus.QUESTION }),
      state({ paneId: '%3', status: AgentStatus.BUSY }),
      state({ paneId: '%4', status: AgentStatus.IDLE }),
    ]);
    const header = renderHeader(app, 120).join('');
    expect(header).toContain('2 need you');
    expect(header).toContain('1 working');
    expect(header).toContain('1 idle');
  });

  test('quiet fleet shows only idle count', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1', status: AgentStatus.IDLE })]);
    const header = renderHeader(app, 120).join('');
    expect(header).not.toContain('need you');
    expect(header).toContain('1 idle');
  });
});
```

(`state()` = the existing test-fixture helper in `dashboard.test.ts`; reuse it as-is.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/dashboard.test.ts`
Expected: FAIL — header contains `1 waiting`, not `need you`

- [ ] **Step 3: Replace `renderHeader`**

```ts
export function renderHeader(app: TuiApp, cols: number): string[] {
  const s = app.summary();
  const agentCount = s.total - app.shellCount();
  const idle = agentCount - s.permit - s.question - s.done - s.busy;

  const badges: string[] = [];
  const needsYou = s.permit + s.question;
  if (needsYou > 0) badges.push(`${C.permit}${C.bold}${needsYou} need you${C.reset}`);
  if (s.busy > 0) badges.push(`${C.busy}${s.busy} working${C.reset}`);
  if (s.done > 0) badges.push(`${C.done}${s.done} ready${C.reset}`);
  if (idle > 0) badges.push(`${C.gray}${idle} idle${C.reset}`);

  const title = ` ${C.bold}${logo()}${C.reset} ${C.gray}${BOX_H} ${agentCount} agents · ${getQuip()}${C.reset}`;
  const badgeStr = badges.length > 0 ? `  ${badges.join(` ${C.dim}·${C.reset} `)}` : '';
  return [truncateAnsi(`${C.gray}┌${BOX_H}${C.reset}${title}${badgeStr}`, cols)];
}
```

- [ ] **Step 4: Run tests — fix any existing header assertions**

Run: `bun test`
Expected: the 2 new tests PASS. If existing header tests asserted on `waiting`/`asking` badge text, update those assertions to the new strip vocabulary (`need you`) — the behavior change is intended by the spec.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/tui/dashboard.ts src/tui/dashboard.test.ts
git commit -m "feat: header summary strip with need-you aggregate and idle count"
```

---

### Task 6: Layout infrastructure — extraction, line/state mapping, scroll indicators

**Files:**
- Create: `src/tui/layouts/index.ts`, `src/tui/layouts/shared.ts`, `src/tui/layouts/table.ts`
- Modify: `src/tui/dashboard.ts` (becomes header/footer/dispatcher + re-exports)
- Modify: `index.ts:642` (`stateAtLine` call gains `cols`)
- Test: `src/tui/layouts/shared.test.ts`; existing `dashboard.test.ts` must stay green via re-exports

**Interfaces:**
- Consumes: `DashboardRow`, `TuiApp`, ANSI helpers, `C`.
- Produces (used by Tasks 7–9):
  - `pickLayout(cols: number): 'table' | 'cards'` and `CARD_LAYOUT_MAX_COLS = 48` (`layouts/index.ts`)
  - `interface LayoutLines { lines: string[]; states: (AgentState | null)[] }` — parallel arrays, one entry per rendered line (`layouts/shared.ts`)
  - `windowLines(all: LayoutLines, selectedLine: number, maxRows: number): LayoutLines` — scroll windowing WITH `↑/↓ N more` indicator lines (indicator lines map to `null` state)
  - `buildTableLines(app: TuiApp, cols: number): LayoutLines` (`layouts/table.ts`)
  - `getStateColor`, `getAgeColor`, `formatAge`, `calculateScroll` move to `layouts/shared.ts`; `dashboard.ts` re-exports them plus `computeColumnWidths` so existing imports/tests keep compiling.
  - `renderSessionList(app, maxRows, cols)` keeps its signature; **`stateAtLine` gains a `cols` parameter** — update its one caller in `index.ts:642` in this task.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tui/layouts/shared.test.ts
import { describe, expect, test } from 'bun:test';
import { windowLines, type LayoutLines } from './shared.ts';
import { CARD_LAYOUT_MAX_COLS, pickLayout } from './index.ts';

const fake = (n: number): LayoutLines => ({
  lines: Array.from({ length: n }, (_, i) => `line${i}`),
  states: Array.from({ length: n }, () => null),
});

describe('pickLayout', () => {
  test('narrow is cards, wide is table', () => {
    expect(pickLayout(CARD_LAYOUT_MAX_COLS - 1)).toBe('cards');
    expect(pickLayout(CARD_LAYOUT_MAX_COLS)).toBe('table');
    expect(pickLayout(200)).toBe('table');
  });
});

describe('windowLines', () => {
  test('short content passes through without indicators', () => {
    const w = windowLines(fake(5), 0, 10);
    expect(w.lines).toHaveLength(5);
    expect(w.lines.join('')).not.toContain('more');
  });

  test('scrolled-down content shows a top indicator counting hidden lines', () => {
    const w = windowLines(fake(30), 29, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[0]).toContain('↑');
    expect(w.lines[0]).toContain('more');
    expect(w.states[0]).toBeNull();
  });

  test('content below shows a bottom indicator', () => {
    const w = windowLines(fake(30), 0, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[9]).toContain('↓ 21 more');
  });

  test('middle position shows both indicators and stays within maxRows', () => {
    const w = windowLines(fake(30), 15, 10);
    expect(w.lines).toHaveLength(10);
    expect(w.lines[0]).toContain('↑');
    expect(w.lines[9]).toContain('↓');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/layouts/shared.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the layouts modules**

```ts
// src/tui/layouts/index.ts
export const CARD_LAYOUT_MAX_COLS = 48;

export type LayoutKind = 'table' | 'cards';

export function pickLayout(cols: number): LayoutKind {
  return cols < CARD_LAYOUT_MAX_COLS ? 'cards' : 'table';
}
```

```ts
// src/tui/layouts/shared.ts
import { C } from '../../terminal/colors.ts';
import { AgentStatus, type AgentState } from '../../state/types.ts';

// One entry per rendered line: states[i] is the agent on lines[i], or null for
// chrome lines (headers, separators, indicators). Render and hit-testing both
// consume this, so a click can never disagree with what was drawn.
export interface LayoutLines {
  lines: string[];
  states: (AgentState | null)[];
}

export function getStateColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.PERMIT:
      return C.permit;
    case AgentStatus.QUESTION:
      return C.question;
    case AgentStatus.DONE:
      return C.done;
    case AgentStatus.BUSY:
      return C.busy;
    case AgentStatus.IDLE:
      return C.idle;
    case AgentStatus.SHELL:
      return C.shell;
    case AgentStatus.DOWN:
      return C.down;
  }
}

export function getAgeColor(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 30) return C.green;
  if (secs < 300) return C.gray;
  return C.down;
}

export function formatAge(ts: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function calculateScroll(selected: number, viewHeight: number, total: number): number {
  if (total <= viewHeight) return 0;
  const half = Math.floor(viewHeight / 2);
  if (selected <= half) return 0;
  if (selected >= total - half) return Math.max(0, total - viewHeight);
  return selected - half;
}

// Window `all` to maxRows around selectedLine, adding ↑/↓ indicator lines when
// content is clipped. Indicator lines carry a null state.
export function windowLines(all: LayoutLines, selectedLine: number, maxRows: number): LayoutLines {
  const total = all.lines.length;
  if (total <= maxRows) return all;

  let inner = maxRows;
  let offset = calculateScroll(selectedLine, inner, total);
  const showTop = offset > 0;
  const showBot = offset + inner < total;
  inner = maxRows - (showTop ? 1 : 0) - (showBot ? 1 : 0);
  offset = calculateScroll(selectedLine, inner, total);

  const lines: string[] = [];
  const states: (AgentState | null)[] = [];
  if (showTop) {
    lines.push(`${C.gray}  ↑ ${offset} more${C.reset}`);
    states.push(null);
  }
  lines.push(...all.lines.slice(offset, offset + inner));
  states.push(...all.states.slice(offset, offset + inner));
  if (showBot) {
    lines.push(`${C.gray}  ↓ ${total - offset - inner} more${C.reset}`);
    states.push(null);
  }
  return { lines, states };
}
```

`src/tui/layouts/table.ts`: move — verbatim, imports adjusted to `../../` — from `dashboard.ts`: `ColumnWidths`, `computeColumnWidths`, `nameCell`, `formatHeaderRow`, `formatAgentRow` (internals unchanged in this task). Then add:

```ts
export function buildTableLines(app: TuiApp, cols: number): LayoutLines {
  const rows = app.dashboardRows();
  const widths = computeColumnWidths(rows, cols);
  const selectedPane = app.selectedState()?.paneId ?? null;
  const lines: string[] = [];
  const states: (AgentState | null)[] = [];
  for (const row of rows) {
    if (row.kind === 'header') {
      lines.push(formatHeaderRow(row, cols));
      states.push(null);
    } else {
      lines.push(formatAgentRow(row, widths, cols, row.state.paneId === selectedPane));
      states.push(row.state);
    }
  }
  return { lines, states };
}
```

Rework `dashboard.ts`: delete the moved functions; keep `renderHeader`/`renderFooter` and the Task 4 empty-state block; route list rendering and hit-testing through one builder:

```ts
import { buildTableLines } from './layouts/table.ts';
import { windowLines, type LayoutLines } from './layouts/shared.ts';

function buildLines(app: TuiApp, cols: number): LayoutLines {
  return buildTableLines(app, cols); // Task 7 adds the cards dispatch here
}

// Line index (chrome lines included) of the selected agent within built lines.
function selectedLineIndex(app: TuiApp, cols: number): number {
  const selected = app.selectedState();
  if (!selected) return 0;
  const built = buildLines(app, cols);
  return Math.max(0, built.states.findIndex((s) => s?.paneId === selected.paneId));
}

export function renderSessionList(app: TuiApp, maxRows: number, cols: number): string[] {
  const rows = app.dashboardRows();
  if (rows.length === 0) {
    /* Task 4 empty-state block stays here verbatim */
  }
  return windowLines(buildLines(app, cols), selectedLineIndex(app, cols), maxRows).lines;
}

export function stateAtLine(app: TuiApp, lineIdx: number, maxRows: number, cols: number): AgentState | null {
  const windowed = windowLines(buildLines(app, cols), selectedLineIndex(app, cols), maxRows);
  return windowed.states[lineIdx] ?? null;
}

export { computeColumnWidths, type ColumnWidths } from './layouts/table.ts';
export { calculateScroll, formatAge, getAgeColor, getStateColor } from './layouts/shared.ts';
```

Update the `stateAtLine` caller (`index.ts:642`):

```ts
            const listCols = app.mode === TuiMode.DASHBOARD ? sz.cols : app.listWidth(sz.cols);
            const sel = lineIdx >= 0 ? stateAtLine(app, lineIdx, contentRows, listCols) : null;
```

- [ ] **Step 4: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: green. `dashboard.test.ts` compiles against the re-exports; update scroll-behavior assertions where indicator lines legitimately change output (a 30-row list in a 10-row viewport now spends 1–2 lines on indicators).

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/tui/layouts/ src/tui/dashboard.ts src/tui/dashboard.test.ts index.ts
git commit -m "refactor: extract table layout, add line/state mapping and scroll indicators"
```

---

### Task 7: Card layout for narrow widths

**Files:**
- Create: `src/tui/layouts/cards.ts`
- Modify: `src/tui/dashboard.ts` (dispatch on `pickLayout`; compact footer)
- Test: `src/tui/layouts/cards.test.ts`

**Interfaces:**
- Consumes: `LayoutLines`, shared helpers, `DashboardRow`, `STATUS_DISPLAY`.
- Produces: `buildCardLines(app: TuiApp, cols: number): LayoutLines`. Cards are **4 lines each** (name/meta/detail/blank separator; the list's trailing blank is trimmed) — uniform height keeps windowing trivial. Session groups render as one dim separator line. Task 8 reuses the `states` mapping for card hit-testing; Task 9 restyles the icon via `stateIcon`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tui/layouts/cards.test.ts
import { describe, expect, test } from 'bun:test';
import { TuiApp } from '../app.ts';
import { AgentStatus, type AgentState } from '../../state/types.ts';
import { visibleLength } from '../../terminal/ansi.ts';
import { buildCardLines } from './cards.ts';

const state = (over: Partial<AgentState>): AgentState => ({
  paneId: '%1',
  paneNum: 1,
  session: 'api',
  window: 'api',
  claudeName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/api',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...over,
});

describe('buildCardLines', () => {
  test('one agent renders exactly 4 lines with parallel state mapping', () => {
    const app = new TuiApp();
    app.updateStates([state({ status: AgentStatus.PERMIT, tool: 'Bash' })]);
    const built = buildCardLines(app, 34);
    expect(built.lines.length).toBeGreaterThanOrEqual(3); // trailing blank trimmed
    expect(built.states[0]?.paneId).toBe('%1');
    expect(built.states[1]?.paneId).toBe('%1'); // every card line hit-tests to its agent
    expect(built.lines[0]).toContain('api');
    expect(built.lines[1]).toContain('main · claude');
    expect(built.lines[2]).toContain('Bash');
  });

  test('selected card carries the ▌ bar on all content lines', () => {
    const app = new TuiApp();
    app.updateStates([state({})]);
    const built = buildCardLines(app, 34);
    expect(built.lines[0]).toContain('▌');
    expect(built.lines[1]).toContain('▌');
    expect(built.lines[2]).toContain('▌');
  });

  test('multi-agent session renders a separator line before its cards', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1', window: 'one' }), state({ paneId: '%2', window: 'two' })]);
    const built = buildCardLines(app, 34);
    expect(built.lines[0]).toContain('api');
    expect(built.lines[0]).toContain('2');
    expect(built.states[0]).toBeNull();
  });

  test('no line exceeds the requested width', () => {
    const app = new TuiApp();
    app.updateStates([state({ branch: 'feature/very-long-branch-name-here', tool: 'WebFetch' })]);
    for (const line of buildCardLines(app, 30).lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(30);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/layouts/cards.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/tui/layouts/cards.ts
import { C } from '../../terminal/colors.ts';
import { truncateAnsi, truncateWidth, visibleLength } from '../../terminal/ansi.ts';
import { STATUS_DISPLAY, windowLabel, type AgentState } from '../../state/types.ts';
import type { TuiApp } from '../app.ts';
import { formatAge, getAgeColor, getStateColor, type LayoutLines } from './shared.ts';

// Sidebar cards: every agent is a fixed 4-line block —
//   ▌⚠ name            4s
//   ▌  branch · agent
//   ▌  tool / state label
//   (blank)
// Uniform height keeps scroll math identical to the table's line windowing.
export function buildCardLines(app: TuiApp, cols: number): LayoutLines {
  const rows = app.dashboardRows();
  const selectedPane = app.selectedState()?.paneId ?? null;
  const lines: string[] = [];
  const states: (AgentState | null)[] = [];

  for (const row of rows) {
    if (row.kind === 'header') {
      const label = ` ${row.session} · ${row.count} `;
      const fill = Math.max(0, cols - visibleLength(label) - 4);
      lines.push(truncateAnsi(`${C.gray}──${C.bold}${label}${C.reset}${C.gray}${'─'.repeat(fill)}${C.reset}`, cols));
      states.push(null);
      continue;
    }
    const st = row.state;
    const selected = st.paneId === selectedPane;
    const color = getStateColor(st.status);
    const display = STATUS_DISPLAY[st.status];
    const bar = selected ? `${color}▌${C.reset}` : ' ';

    const age = formatAge(st.ts);
    // line 1 visible budget: bar(1) sp(1) icon(1) sp(1) name … sp(1) age
    const nameW = Math.max(1, cols - 5 - age.length);
    const name = truncateWidth(windowLabel(st) === st.session ? st.session : `${st.session} · ${windowLabel(st)}`, nameW);
    const gap = ' '.repeat(Math.max(1, nameW - visibleLength(name) + 1));
    lines.push(
      truncateAnsi(
        `${bar} ${color}${display.icon}${C.reset} ${selected ? C.bold : ''}${name}${C.reset}${gap}${getAgeColor(st.ts)}${age}${C.reset}`,
        cols,
      ),
    );
    states.push(st);

    const meta = [st.branch, st.agentType].filter(Boolean).join(' · ');
    lines.push(truncateAnsi(`${bar}   ${C.gray}${truncateWidth(meta, Math.max(1, cols - 4))}${C.reset}`, cols));
    states.push(st);

    const detail = st.tool ?? st.claudeName ?? display.label;
    lines.push(truncateAnsi(`${bar}   ${C.dim}${truncateWidth(detail, Math.max(1, cols - 4))}${C.reset}`, cols));
    states.push(st);

    lines.push('');
    states.push(null);
  }

  // Drop the trailing blank so the last card doesn't waste a row.
  if (lines[lines.length - 1] === '') {
    lines.pop();
    states.pop();
  }
  return { lines, states };
}
```

`src/tui/dashboard.ts` — complete the dispatcher from Task 6:

```ts
import { buildCardLines } from './layouts/cards.ts';
import { pickLayout } from './layouts/index.ts';

function buildLines(app: TuiApp, cols: number): LayoutLines {
  return pickLayout(cols) === 'cards' ? buildCardLines(app, cols) : buildTableLines(app, cols);
}
```

Compact footer — at the top of `renderFooter`:

```ts
  if (pickLayout(cols) === 'cards') {
    const hints = [
      `${chip('⏎')} ${C.gray}switch${C.reset}`,
      `${chip('?')} ${C.gray}help${C.reset}`,
      `${chip('q')} ${C.gray}quit${C.reset}`,
    ];
    return [truncateAnsi(`${C.gray}${BOX_H}${C.reset} ${hints.join('  ')}`, cols)];
  }
```

- [ ] **Step 4: Run the full suite + live check**

Run: `bun test && bun run typecheck`
Live: `tmux split-window -h -l 34 "/opt/homebrew/bin/bun run --cwd /Users/nicknisi/Developer/fleet dev"` — cards render, Enter jumps, `q` quits and the pane closes.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/tui/layouts/cards.ts src/tui/layouts/cards.test.ts src/tui/dashboard.ts
git commit -m "feat: card layout below 48 cols with compact footer"
```

---

### Task 8: Hover highlight + unified hit-testing (mouse any-event mode)

**Files:**
- Modify: `src/terminal/terminal.ts:11-12` (mouse modes), `src/terminal/mouse.ts:10-19` (delete duplicate enable/disable)
- Modify: `src/tui/app.ts` (hover field), `src/tui/layouts/table.ts` + `cards.ts` (hover style), `index.ts` mouse handler
- Test: `src/tui/app.test.ts` (hover lifecycle), `src/tui/dashboard.test.ts` (smoke)

**Interfaces:**
- Consumes: `stateAtLine(app, lineIdx, maxRows, cols)` from Task 6/7, `C.underline` from Task 2.
- Produces: `TuiApp.hoverPaneId: string | null`; hovered (non-selected) rows render their name underlined. Mouse modes become `?1002 + ?1003 + ?1006` (any-event tracking) owned solely by `terminal.ts`.

- [ ] **Step 1: Write the failing tests** (hover lifecycle in `src/tui/app.test.ts`, using its existing state fixture)

```ts
describe('hover', () => {
  test('updateStates clears hover for vanished panes', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1' })]);
    app.hoverPaneId = '%1';
    app.updateStates([]);
    expect(app.hoverPaneId).toBeNull();
  });

  test('updateStates keeps hover for surviving panes', () => {
    const app = new TuiApp();
    app.updateStates([state({ paneId: '%1' })]);
    app.hoverPaneId = '%1';
    app.updateStates([state({ paneId: '%1' })]);
    expect(app.hoverPaneId).toBe('%1');
  });
});
```

(Underline styling itself is invisible under `bun test` — `C.underline` is `''` without a TTY — so the render assertion surface is the manual check in Step 4.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/app.test.ts`
Expected: FAIL — `hoverPaneId` does not exist

- [ ] **Step 3: Implement**

`src/terminal/terminal.ts` — any-event tracking:

```ts
const ENABLE_MOUSE = '\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1002l\x1b[?1003l\x1b[?1006l';
```

`src/terminal/mouse.ts` — delete its `ENABLE_MOUSE`/`DISABLE_MOUSE` consts and `enableMouse`/`disableMouse` functions (terminal.ts is the single owner; `parseMouseEvent` already decodes motion codes). Verify nothing else imports them: `grep -rn "mouse.ts'" src index.ts` must show only `parseMouseEvent`/`isMouseSequence` imports.

`src/tui/app.ts`:

```ts
  hoverPaneId: string | null = null;
```

and in `updateStates`, after `this.states = newStates;`:

```ts
    if (this.hoverPaneId && !newStates.some((s) => s.paneId === this.hoverPaneId)) {
      this.hoverPaneId = null;
    }
```

`src/tui/layouts/table.ts` — `formatAgentRow` gains a `hovered: boolean` parameter (threaded from `buildTableLines` via `row.state.paneId === app.hoverPaneId`); the name styling becomes:

```ts
  const nameColor = selected ? C.bold : hovered ? C.underline : '';
```

`src/tui/layouts/cards.ts` — same on card line 1: `selected ? C.bold : hovered ? C.underline : ''` (thread `hovered` the same way).

`index.ts` mouse handler — the click branch and the new hover branch share their geometry; add one local helper inside `handleInput` and use it from both:

```ts
      const listHit = (mx: number, my: number): AgentState | null => {
        const inList = app.mode === TuiMode.DASHBOARD || mx <= app.listWidth(sz.cols);
        if (!inList) return null;
        const headerHeight = renderHeader(app, sz.cols).length;
        const contentRows = sz.rows - headerHeight - renderFooter(app, sz.cols).length - 1;
        const lineIdx = my - headerHeight - 2;
        if (lineIdx < 0) return null;
        const listCols = app.mode === TuiMode.DASHBOARD ? sz.cols : app.listWidth(sz.cols);
        return stateAtLine(app, lineIdx, contentRows, listCols);
      };
```

Hover branch (after the divider-drag block, before the click block):

```ts
        if (mouse.type === 'move' && !app.dragging) {
          const id = listHit(mouse.x, mouse.y)?.paneId ?? null;
          if (id !== app.hoverPaneId) {
            app.hoverPaneId = id;
            needsRender = true;
          }
          return;
        }
```

Rewrite the existing click branch body to use `listHit(mouse.x, mouse.y)` in place of its inline header/contentRows/lineIdx/stateAtLine math (the acknowledge-on-DONE and select behavior stays exactly as is).

- [ ] **Step 4: Run tests + manual verification**

Run: `bun test && bun run typecheck`
Manual: `bun run dev` — hovering underlines names without clicks; leaving the list clears it; renders fire only on hover change (no CPU churn when parked); click-select still works at table and card widths; divider drag still works.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/terminal/terminal.ts src/terminal/mouse.ts src/tui/app.ts src/tui/layouts/ src/tui/app.test.ts index.ts
git commit -m "feat: hover highlight via any-event mouse tracking, single-owner mouse modes"
```

---

### Task 9: Busy pulse on the fast tick

**Files:**
- Modify: `src/tui/app.ts` (pulse field), `src/tui/layouts/shared.ts` (icon helper), `table.ts`, `cards.ts`, `index.ts` (tick flip)
- Test: `src/tui/layouts/shared.test.ts`

**Interfaces:**
- Consumes: `C.dim`, `getStateColor`, `STATUS_DISPLAY`.
- Produces: `stateIcon(status: AgentStatus, pulsePhase: boolean): string` in `layouts/shared.ts`; `TuiApp.pulsePhase: boolean`. Both layouts render agent-row icons exclusively through `stateIcon`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('stateIcon', () => {
  test('busy icon renders the working glyph in both phases', () => {
    expect(stateIcon(AgentStatus.BUSY, false)).toContain('◉');
    expect(stateIcon(AgentStatus.BUSY, true)).toContain('◉');
  });
  test('non-busy states ignore the pulse phase entirely', () => {
    expect(stateIcon(AgentStatus.PERMIT, true)).toBe(stateIcon(AgentStatus.PERMIT, false));
    expect(stateIcon(AgentStatus.IDLE, true)).toBe(stateIcon(AgentStatus.IDLE, false));
  });
});
```

(Escape codes are `''` under `bun test`, so phase difference is asserted structurally: non-busy invariance + manual check.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/layouts/shared.test.ts`
Expected: FAIL — `stateIcon` not exported

- [ ] **Step 3: Implement**

`src/tui/layouts/shared.ts`:

```ts
import { STATUS_DISPLAY } from '../../state/types.ts';

// BUSY breathes: alternate dim/normal each fast tick. Everything else is steady.
export function stateIcon(status: AgentStatus, pulsePhase: boolean): string {
  const icon = STATUS_DISPLAY[status].icon;
  const color = getStateColor(status);
  if (status === AgentStatus.BUSY && pulsePhase) return `${C.dim}${color}${icon}${C.reset}`;
  return `${color}${icon}${C.reset}`;
}
```

`src/tui/app.ts`: add `pulsePhase: boolean = false;`.

`table.ts` `formatAgentRow` and `cards.ts` card line 1: replace the inline `${color}${display.icon}${C.reset}` with `stateIcon(state.status, pulse)` — thread `pulse` from `buildTableLines`/`buildCardLines` via `app.pulsePhase`. (Table session-header rows keep their steady aggregate icon — only agent rows pulse.)

`index.ts` fast timer (currently `index.ts:815-819`):

```ts
    refreshTimer = setInterval(() => {
      if (isTyping()) return;
      doRefresh();
      if (app.visibleStates().some((s) => s.status === AgentStatus.BUSY)) {
        app.pulsePhase = !app.pulsePhase;
        needsRender = true;
      }
      tick();
    }, FAST_REFRESH_MS);
```

- [ ] **Step 4: Run tests + manual verification**

Run: `bun test && bun run typecheck`
Manual: `bun run dev` with one agent working — its ◉ breathes at 1Hz; a fully idle dashboard triggers no extra renders.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/tui/app.ts src/tui/layouts/ index.ts
git commit -m "feat: busy icons pulse on the existing fast tick"
```

---

### Task 10: tmux sidebar/popup keybindings in fleet install

**Files:**
- Modify: `src/cli/install.ts`
- Test: `src/cli/install.test.ts` (extend; follows the existing tmp-file pattern used for `addTmuxConfLine`)

**Interfaces:**
- Consumes: `FLEET_MANAGED_MARKER`, `tmuxConfPath()`, existing `removeTmuxConfLine` (already strips ALL marker lines, so uninstall needs zero changes).
- Produces: `addTmuxKeybindLines(path: string, ask: (q: string) => boolean): string[]` (returns lines actually added; injectable `ask` keeps tests off the TTY), wired into `runInstall` with a TTY yes/no prompt.

- [ ] **Step 1: Write the failing tests**

```ts
import { addTmuxKeybindLines } from './install.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('addTmuxKeybindLines', () => {
  const confWith = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-test-'));
    const path = join(dir, 'tmux.conf');
    writeFileSync(path, content);
    return path;
  };

  test('accepting both prompts appends both managed bindings', () => {
    const path = confWith('set -g mouse on\n');
    const added = addTmuxKeybindLines(path, () => true);
    expect(added).toHaveLength(2);
    const conf = readFileSync(path, 'utf8');
    expect(conf).toContain('bind-key f split-window');
    expect(conf).toContain('bind-key F display-popup');
    expect(conf.match(/# fleet-managed/g)?.length).toBe(2);
  });

  test('declining adds nothing and leaves the file untouched', () => {
    const path = confWith('set -g mouse on\n');
    expect(addTmuxKeybindLines(path, () => false)).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('set -g mouse on\n');
  });

  test('idempotent: existing bindings are not re-added or re-asked', () => {
    const path = confWith('set -g mouse on\n');
    addTmuxKeybindLines(path, () => true);
    let asked = 0;
    const added = addTmuxKeybindLines(path, () => (asked++, true));
    expect(added).toHaveLength(0);
    expect(asked).toBe(0);
  });

  test('missing conf file adds nothing', () => {
    expect(addTmuxKeybindLines('/nonexistent/tmux.conf', () => true)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/cli/install.test.ts`
Expected: FAIL — `addTmuxKeybindLines` not exported

- [ ] **Step 3: Implement in `src/cli/install.ts`**

```ts
import { readSync } from 'node:fs'; // merge into the existing node:fs import

const FLEET_KEYBIND_SIDEBAR = `bind-key f split-window -hb -l 34 fleet ${FLEET_MANAGED_MARKER}`;
const FLEET_KEYBIND_POPUP = `bind-key F display-popup -E -w 80% -h 60% fleet ${FLEET_MANAGED_MARKER}`;

// Offer the sidebar/popup bindings one at a time. `ask` is injected so tests
// don't touch a TTY. Declined bindings are printed for manual adoption.
// Uninstall needs no changes: removeTmuxConfLine strips every marker line.
export function addTmuxKeybindLines(path: string, ask: (question: string) => boolean): string[] {
  if (!existsSync(path)) return [];
  let contents = readFileSync(path, 'utf8');
  const added: string[] = [];
  const candidates = [
    { line: FLEET_KEYBIND_SIDEBAR, question: 'Add tmux binding — prefix+f: fleet in a 34-col sidebar split? [y/N] ' },
    { line: FLEET_KEYBIND_POPUP, question: 'Add tmux binding — prefix+F: fleet in a popup? [y/N] ' },
  ];
  for (const cand of candidates) {
    if (contents.includes(cand.line)) continue;
    if (ask(cand.question)) {
      contents += (contents.endsWith('\n') || contents.length === 0 ? '' : '\n') + cand.line + '\n';
      added.push(cand.line);
    } else {
      process.stdout.write(`  skipped — add it yourself anytime:\n    ${cand.line}\n`);
    }
  }
  if (added.length > 0) writeFileSync(path, contents);
  return added;
}

function askYesNo(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  try {
    const n = readSync(0, buf, 0, 64, null);
    return /^y/i.test(buf.subarray(0, n).toString().trim());
  } catch {
    return false;
  }
}
```

Wire into `runInstall` after the `addTmuxConfLine` block (before `runStatusLineInject()`):

```ts
  const addedBindings = addTmuxKeybindLines(confPath, askYesNo);
  if (addedBindings.length > 0) {
    process.stdout.write(`Added ${addedBindings.length} fleet keybinding(s) — reload with: tmux source-file ${confPath}\n`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run format
git add src/cli/install.ts src/cli/install.test.ts
git commit -m "feat: offer sidebar and popup tmux keybindings during fleet install"
```

---

### Task 11: Docs + final verification sweep

**Files:**
- Modify: `README.md`
- Test: none (docs)

- [ ] **Step 1: Update README**

Add/adjust these sections, matching the README's existing voice:
1. **Theming** (new section): the detection chain in user terms — auto light/dark via macOS appearance (and OSC 11 outside tmux), override with `FLEET_THEME=light|dark` or `tmux set -g @fleet-theme light`; `NO_COLOR` still honored.
2. **Sidebar & popup** (new section under usage): `prefix+f` (34-col sidebar) and `prefix+F` (popup) offered by `fleet install`; below 48 columns fleet reflows to cards automatically.
3. **UI notes**: hover, scroll indicators, busy pulse — one line each.
4. Fix the stale test count: replace "166 tests" with the real number from `bun test` output after Task 10.

- [ ] **Step 2: Full verification matrix** (from the spec — run each, note pass/fail in the PR description)

```bash
bun test && bun run typecheck && bun run lint && bun run format && bun run build
```

- Dark terminal (Ghostty dark): states legible, Mocha
- Light terminal (Ghostty light or `FLEET_THEME=light`): states legible, Latte
- `NO_COLOR=1`: monochrome, readable
- Non-TTY (`fleet status | cat`): no escapes
- 34-col tmux split: cards, compact footer, Enter jumps
- Wide pane: table + preview unchanged
- `tmux display-popup -E fleet`: renders, `q` closes
- Outside tmux / tmux stopped: "tmux isn't running" state, not "all quiet"
- Hover, click-select, divider drag, scroll indicators with more agents than viewport, busy pulse with a working agent

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: theming, sidebar/popup bindings, card layout"
```
