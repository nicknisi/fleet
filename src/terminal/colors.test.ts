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
