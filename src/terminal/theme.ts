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
    const mode = resolveThemeMode({
      envTheme,
      tmuxOption,
      oscBackground: null,
      colorFgBg: undefined,
      macAppearance: null,
    });
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
