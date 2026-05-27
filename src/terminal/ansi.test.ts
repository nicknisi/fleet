import { describe, expect, test } from 'bun:test';
import { stripAnsi, truncateAnsi, visibleLength } from './ansi.ts';

describe('stripAnsi', () => {
  test('removes SGR sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
  });

  test('removes 256-color and truecolor sequences', () => {
    expect(stripAnsi('\x1b[38;5;196mred256\x1b[0m')).toBe('red256');
    expect(stripAnsi('\x1b[38;2;255;0;0mtruecolor\x1b[0m')).toBe('truecolor');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  test('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('does not leave orphan ESC bytes', () => {
    const result = stripAnsi('\x1b[31mred\x1b[0m');
    expect(result).toBe('red');
    expect(result.length).toBe(3);
  });
});

describe('visibleLength', () => {
  test('counts only visible characters', () => {
    expect(visibleLength('\x1b[31mred\x1b[0m plain')).toBe(9);
  });

  test('returns 0 for ANSI-only string', () => {
    expect(visibleLength('\x1b[31m\x1b[0m')).toBe(0);
  });

  test('counts emoji as 2 columns', () => {
    expect(visibleLength('🔒 lock')).toBe(7);
    expect(visibleLength('😺')).toBe(2);
  });

  test('counts plain ASCII as 1 column each', () => {
    expect(visibleLength('hello')).toBe(5);
  });

  test('handles emoji with ANSI codes', () => {
    expect(visibleLength('\x1b[32m🔒\x1b[0m lock')).toBe(7);
  });
});

describe('truncateAnsi', () => {
  test('preserves SGR sequences and counts only visible chars', () => {
    expect(truncateAnsi('\x1b[31mred\x1b[0m plain', 5)).toBe('\x1b[31mred\x1b[0m p');
  });

  test('returns empty string for maxWidth=0', () => {
    expect(truncateAnsi('hello', 0)).toBe('');
  });

  test('returns full string when shorter than maxWidth', () => {
    expect(truncateAnsi('hi', 10)).toBe('hi');
  });

  test('handles 256-color sequences', () => {
    expect(truncateAnsi('\x1b[38;5;196mabcdef', 3)).toBe('\x1b[38;5;196mabc');
  });

  test('handles truecolor sequences', () => {
    expect(truncateAnsi('\x1b[38;2;255;0;0mabcdef', 3)).toBe('\x1b[38;2;255;0;0mabc');
  });

  test('handles nested styles', () => {
    const input = '\x1b[1m\x1b[31mbold-red\x1b[0m tail';
    expect(truncateAnsi(input, 4)).toBe('\x1b[1m\x1b[31mbold');
  });

  test('handles empty string', () => {
    expect(truncateAnsi('', 10)).toBe('');
  });

  test('truncates emoji at correct column boundary', () => {
    expect(truncateAnsi('🔒ab', 3)).toBe('🔒a');
    expect(truncateAnsi('🔒ab', 2)).toBe('🔒');
    expect(truncateAnsi('🔒ab', 1)).toBe('');
  });

  test('does not split wide character across boundary', () => {
    expect(truncateAnsi('a🔒b', 2)).toBe('a');
    expect(truncateAnsi('a🔒b', 3)).toBe('a🔒');
  });
});
