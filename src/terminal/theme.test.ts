// src/terminal/theme.test.ts
import { describe, expect, test } from 'bun:test';
import {
  loadCustomStatePalette,
  luminance,
  modeFromBackground,
  modeFromColorFgBg,
  parseOsc11Reply,
  parseStatePalette,
  parseThemeColor,
  resolveThemePath,
  resolveThemeSelection,
  resolveThemeMode,
  shouldQueryOsc,
  stripOsc11Reply,
  type ThemeSignals,
} from './theme.ts';

const paletteSource = {
  colors: {
    permit: 'yellow',
    question: '#CBA6F7',
    done: 'green',
    busy: '#fab387',
    idle: 'blue',
    shell: 'bright-black',
    down: '#45475a',
  },
};

const palette = parseStatePalette(paletteSource);

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

describe('custom state palettes', () => {
  test('maps all 16 ANSI names to their foreground codes', () => {
    const names = [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'bright-black',
      'bright-red',
      'bright-green',
      'bright-yellow',
      'bright-blue',
      'bright-magenta',
      'bright-cyan',
      'bright-white',
    ];
    expect(names.map((name) => parseThemeColor(name))).toEqual(
      [...Array(8).keys(), ...Array(8).keys()].map((offset, index) => ({
        kind: 'ansi',
        code: (index < 8 ? 30 : 90) + offset,
      })),
    );
  });

  test('accepts lowercase and uppercase six-digit RGB', () => {
    expect(parseThemeColor('#cba6f7')).toEqual({ kind: 'rgb', r: 203, g: 166, b: 247 });
    expect(parseThemeColor('#CBA6F7')).toEqual({ kind: 'rgb', r: 203, g: 166, b: 247 });
  });

  test.each(['#fff', '#cba6f7ff', '#gggggg', 'orange', 42])('rejects unsupported color %p', (value) => {
    expect(() => parseThemeColor(value)).toThrow();
  });

  test('accepts a complete mixed palette', () => {
    expect(palette.permit).toEqual({ kind: 'ansi', code: 33 });
    expect(palette.question).toEqual({ kind: 'rgb', r: 203, g: 166, b: 247 });
  });

  for (const key of Object.keys(paletteSource.colors)) {
    test(`rejects a palette missing ${key}`, () => {
      const colors = Object.fromEntries(Object.entries(paletteSource.colors).filter(([k]) => k !== key));
      expect(() => parseStatePalette({ colors })).toThrow(`missing color "${key}"`);
    });
  }

  test('rejects unknown keys and missing or invalid colors tables', () => {
    expect(() => parseStatePalette({ colors: { ...paletteSource.colors, accent: 'red' } })).toThrow(
      'unknown color key "accent"',
    );
    expect(() => parseStatePalette({})).toThrow('theme must contain a [colors] table');
    expect(() => parseStatePalette({ colors: 'red' })).toThrow('theme must contain a [colors] table');
  });
});

describe('custom state palette loader', () => {
  test('resolves XDG_CONFIG_HOME with HOME fallback for unset and empty values', () => {
    expect(resolveThemePath({}, '/home/test')).toBe('/home/test/.config/fleet/theme.toml');
    expect(resolveThemePath({ XDG_CONFIG_HOME: '' }, '/home/test')).toBe('/home/test/.config/fleet/theme.toml');
    expect(resolveThemePath({ XDG_CONFIG_HOME: '/tmp/config' }, '/home/test')).toBe('/tmp/config/fleet/theme.toml');
  });

  test('returns null without warning when the file is missing', () => {
    const warnings: string[] = [];
    expect(
      loadCustomStatePalette({ path: '/missing/theme.toml', exists: () => false, warn: (m) => warnings.push(m) }),
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  test('loads a valid TOML palette', () => {
    const source = Object.entries(paletteSource.colors)
      .map(([key, value]) => `${key} = "${value}"`)
      .join('\n');
    expect(
      loadCustomStatePalette({ path: '/theme.toml', exists: () => true, read: () => `[colors]\n${source}` }),
    ).toEqual(palette);
  });

  test.each([
    ['invalid TOML', () => 'not = [valid'],
    [
      'unreadable file',
      () => {
        throw new Error('permission denied');
      },
    ],
  ])('warns once and falls back for an %s', (_name, read) => {
    const warnings: string[] = [];
    expect(
      loadCustomStatePalette({ path: '/theme.toml', exists: () => true, read, warn: (m) => warnings.push(m) }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/theme.toml');
  });
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
      resolveThemeMode(
        signals({ oscBackground: { r: 255, g: 255, b: 255 }, colorFgBg: '15;0', macAppearance: 'Dark' }),
      ),
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

describe('resolveThemeSelection precedence', () => {
  const withPalette = (over: Partial<ThemeSignals>) => signals({ customPalette: palette, ...over });

  test('valid environment and tmux modes beat the custom palette', () => {
    expect(resolveThemeSelection(withPalette({ envTheme: 'light', tmuxOption: 'dark' }))).toEqual({
      mode: 'light',
      palette: null,
    });
    expect(resolveThemeSelection(withPalette({ tmuxOption: 'dark' }))).toEqual({ mode: 'dark', palette: null });
  });

  test('custom palette beats automatic detection', () => {
    expect(resolveThemeSelection(withPalette({ oscBackground: { r: 255, g: 255, b: 255 } }))).toEqual({
      mode: null,
      palette,
    });
  });

  test('invalid overrides do not block the custom palette', () => {
    expect(resolveThemeSelection(withPalette({ envTheme: 'solarized', tmuxOption: 'auto' }))).toEqual({
      mode: null,
      palette,
    });
  });
});

describe('shouldQueryOsc', () => {
  test('queries when outside tmux with no overrides', () => {
    expect(shouldQueryOsc({}, null)).toBe(true);
  });
  test('skips inside tmux', () => {
    expect(shouldQueryOsc({ TMUX: '/tmp/tmux-501/default,123,0' }, null)).toBe(false);
  });
  test('skips on explicit env or tmux option', () => {
    expect(shouldQueryOsc({ FLEET_THEME: 'light' }, null)).toBe(false);
    expect(shouldQueryOsc({}, 'dark')).toBe(false);
  });
  test('skips when a valid custom palette is selected', () => {
    expect(shouldQueryOsc({}, null, palette)).toBe(false);
  });
  test('invalid override values do not skip by themselves', () => {
    expect(shouldQueryOsc({ FLEET_THEME: 'solarized' }, 'auto')).toBe(true);
  });
});
