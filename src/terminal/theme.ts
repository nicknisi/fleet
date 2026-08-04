// src/terminal/theme.ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getTmuxOption } from '../tmux/ipc.ts';
import type { StateColorKey, StatePalette, ThemeColor } from './colors.ts';

export type ThemeMode = 'light' | 'dark';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const STATE_COLOR_KEYS = ['permit', 'question', 'done', 'busy', 'idle', 'shell', 'down'] as const;

const ANSI_FOREGROUND_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  'bright-black': 90,
  'bright-red': 91,
  'bright-green': 92,
  'bright-yellow': 93,
  'bright-blue': 94,
  'bright-magenta': 95,
  'bright-cyan': 96,
  'bright-white': 97,
};

export function parseThemeColor(value: unknown): ThemeColor {
  if (typeof value !== 'string') throw new Error('color values must be strings');
  const ansiCode = ANSI_FOREGROUND_CODES[value];
  if (ansiCode !== undefined) return { kind: 'ansi', code: ansiCode };
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return {
      kind: 'rgb',
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16),
    };
  }
  throw new Error(`unsupported color ${JSON.stringify(value)}`);
}

function parsePaletteColor(key: StateColorKey, value: unknown): ThemeColor {
  try {
    return parseThemeColor(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid ${JSON.stringify(key)}: ${reason}`);
  }
}

export function parseStatePalette(value: unknown): StatePalette {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('theme must contain a [colors] table');
  }
  const colors = (value as Record<string, unknown>).colors;
  if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) {
    throw new Error('theme must contain a [colors] table');
  }
  const colorValues = colors as Record<string, unknown>;
  for (const key of Object.keys(colorValues)) {
    if (!STATE_COLOR_KEYS.includes(key as StateColorKey)) throw new Error(`unknown color key ${JSON.stringify(key)}`);
  }
  const palette = {} as StatePalette;
  for (const key of STATE_COLOR_KEYS) {
    if (!(key in colorValues)) throw new Error(`missing color ${JSON.stringify(key)}`);
    palette[key] = parsePaletteColor(key, colorValues[key]);
  }
  return palette;
}

export function resolveThemePath(env: { XDG_CONFIG_HOME?: string }, home: string): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'fleet', 'theme.toml');
}

interface ThemeLoaderOptions {
  env?: { XDG_CONFIG_HOME?: string };
  home?: string;
  path?: string;
  warn?: (message: string) => void;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

export function loadCustomStatePalette(options: ThemeLoaderOptions = {}): StatePalette | null {
  const env = options.env ?? { XDG_CONFIG_HOME: Bun.env.XDG_CONFIG_HOME };
  const path = options.path ?? resolveThemePath(env, options.home ?? homedir());
  if (!(options.exists ?? existsSync)(path)) return null;
  try {
    return parseStatePalette(Bun.TOML.parse((options.read ?? ((file) => readFileSync(file, 'utf8')))(path)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    (options.warn ?? ((message) => process.stderr.write(`${message}\n`)))(
      `fleet: invalid state palette at ${path}: ${reason}`,
    );
    return null;
  }
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
  customPalette?: StatePalette | null;
}

export type ThemeSelection = { mode: ThemeMode; palette: null } | { mode: null; palette: StatePalette };

export interface ThemeStartup {
  envTheme: string | undefined;
  tmuxOption: string | null;
  customPalette: StatePalette | null;
}

export function resolveThemeSelection(s: ThemeSignals): ThemeSelection {
  if (s.envTheme === 'light' || s.envTheme === 'dark') return { mode: s.envTheme, palette: null };
  if (s.tmuxOption === 'light' || s.tmuxOption === 'dark') return { mode: s.tmuxOption, palette: null };
  if (s.customPalette) return { mode: null, palette: s.customPalette };
  return { mode: resolveThemeMode(s), palette: null };
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

// Whether the OSC 11 round-trip is worth attempting. Inside tmux the query is
// not forwarded to the outer terminal (verified on tmux 3.7a), so waiting out
// the timeout only delays startup — skip straight to the env/OS rungs.
export function shouldQueryOsc(
  env: { TMUX?: string; FLEET_THEME?: string },
  tmuxOption: string | null,
  customPalette: StatePalette | null = null,
): boolean {
  if (env.FLEET_THEME === 'light' || env.FLEET_THEME === 'dark') return false;
  if (tmuxOption === 'light' || tmuxOption === 'dark') return false;
  if (customPalette) return false;
  if (env.TMUX) return false;
  return true;
}

// ---- I/O section: reads env/tmux/OS and performs the OSC 11 round-trip ----

export function readTmuxThemeOption(): string | null {
  return getTmuxOption('@fleet-theme');
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

function explicitThemeMode(envTheme: string | undefined, tmuxOption: string | null): ThemeMode | null {
  if (envTheme === 'light' || envTheme === 'dark') return envTheme;
  if (tmuxOption === 'light' || tmuxOption === 'dark') return tmuxOption;
  return null;
}

export function prepareTheme(): ThemeStartup {
  const envTheme = Bun.env.FLEET_THEME;
  const tmuxOption = readTmuxThemeOption();
  return {
    envTheme,
    tmuxOption,
    customPalette: explicitThemeMode(envTheme, tmuxOption) ? null : loadCustomStatePalette(),
  };
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

export async function detectTheme(startup = prepareTheme()): Promise<{ selection: ThemeSelection; leftover: Buffer }> {
  const { envTheme, tmuxOption, customPalette } = startup;
  const explicitMode = explicitThemeMode(envTheme, tmuxOption);
  if (explicitMode) return { selection: { mode: explicitMode, palette: null }, leftover: Buffer.alloc(0) };

  if (!shouldQueryOsc({ TMUX: Bun.env.TMUX, FLEET_THEME: envTheme }, tmuxOption, customPalette)) {
    const selection = resolveThemeSelection({
      envTheme,
      tmuxOption,
      oscBackground: null,
      colorFgBg: Bun.env.COLORFGBG,
      macAppearance: readMacAppearance(),
      customPalette,
    });
    return { selection, leftover: Buffer.alloc(0) };
  }
  const { background, leftover } = await queryOscBackground();
  const selection = resolveThemeSelection({
    envTheme,
    tmuxOption,
    oscBackground: background,
    colorFgBg: Bun.env.COLORFGBG,
    macAppearance: readMacAppearance(),
    customPalette,
  });
  return { selection, leftover };
}
