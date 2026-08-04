import { afterEach, describe, expect, test } from 'bun:test';
import {
  getThemeMode,
  serializeThemeColor,
  setStatePalette,
  setThemeMode,
  stateThemeColor,
  type StatePalette,
} from './colors.ts';

const customPalette: StatePalette = {
  permit: { kind: 'ansi', code: 33 },
  question: { kind: 'rgb', r: 203, g: 166, b: 247 },
  done: { kind: 'ansi', code: 32 },
  busy: { kind: 'rgb', r: 250, g: 179, b: 135 },
  idle: { kind: 'ansi', code: 34 },
  shell: { kind: 'ansi', code: 90 },
  down: { kind: 'rgb', r: 69, g: 71, b: 90 },
};

describe('theme palettes', () => {
  afterEach(() => setThemeMode('dark'));

  test('defaults to dark (Catppuccin Mocha)', () => {
    expect(getThemeMode()).toBe('dark');
    expect(stateThemeColor('permit')).toEqual({ kind: 'rgb', r: 249, g: 226, b: 175 });
    expect(stateThemeColor('idle')).toEqual({ kind: 'rgb', r: 137, g: 180, b: 250 });
  });

  test('light mode swaps to Catppuccin Latte', () => {
    setThemeMode('light');
    expect(getThemeMode()).toBe('light');
    expect(stateThemeColor('permit')).toEqual({ kind: 'rgb', r: 223, g: 142, b: 29 });
    expect(stateThemeColor('question')).toEqual({ kind: 'rgb', r: 136, g: 57, b: 239 });
    expect(stateThemeColor('done')).toEqual({ kind: 'rgb', r: 64, g: 160, b: 43 });
    expect(stateThemeColor('busy')).toEqual({ kind: 'rgb', r: 254, g: 100, b: 11 });
    expect(stateThemeColor('idle')).toEqual({ kind: 'rgb', r: 30, g: 102, b: 245 });
    expect(stateThemeColor('shell')).toEqual({ kind: 'rgb', r: 156, g: 160, b: 176 });
    expect(stateThemeColor('down')).toEqual({ kind: 'rgb', r: 188, g: 192, b: 204 });
  });

  test('custom palettes can mix ANSI and RGB colors', () => {
    setStatePalette(customPalette);
    expect(getThemeMode()).toBeNull();
    expect(stateThemeColor('permit')).toEqual({ kind: 'ansi', code: 33 });
    expect(stateThemeColor('question')).toEqual({ kind: 'rgb', r: 203, g: 166, b: 247 });
  });
});

describe('serializeThemeColor', () => {
  test('serializes ANSI and RGB foreground colors', () => {
    expect(serializeThemeColor({ kind: 'ansi', code: 94 }, true)).toBe('\x1b[94m');
    expect(serializeThemeColor({ kind: 'rgb', r: 203, g: 166, b: 247 }, true)).toBe('\x1b[38;2;203;166;247m');
  });

  test('emits nothing when colors are disabled', () => {
    expect(serializeThemeColor({ kind: 'ansi', code: 94 }, false)).toBe('');
  });
});
