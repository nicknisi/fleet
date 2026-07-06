import { describe, expect, test } from 'bun:test';
import { oscTitle, padAnsi, stripAnsi, truncateAnsi, truncateWidth, visibleLength } from './ansi.ts';

describe('oscTitle', () => {
  test('wraps title in an OSC 2 sequence', () => {
    expect(oscTitle('fleet — 2 working')).toBe('\x1b]2;fleet — 2 working\x07');
  });

  test('strips control characters that would break the sequence', () => {
    expect(oscTitle('a\x1bb\x07c\nd')).toBe('\x1b]2;abcd\x07');
  });

  test('empty title clears the pane title', () => {
    expect(oscTitle('')).toBe('\x1b]2;\x07');
  });
});

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

describe('padAnsi', () => {
  test('pads plain text to visible width', () => {
    expect(padAnsi('abc', 5)).toBe('abc  ');
  });

  test('pads by visible width, ignoring ANSI codes', () => {
    expect(padAnsi('\x1b[31mab\x1b[0m', 4)).toBe('\x1b[31mab\x1b[0m  ');
  });

  test('emoji counts 2 cells: padded emoji and ASCII strings align', () => {
    // '🤖 workos' = 2 + 1 + 6 = 9 cells; 'workos' = 6 cells
    expect(visibleLength(padAnsi('🤖 workos', 12))).toBe(12);
    expect(visibleLength(padAnsi('workos', 12))).toBe(12);
  });

  test('never truncates: returns value unchanged when at or over width', () => {
    expect(padAnsi('abcdef', 4)).toBe('abcdef');
    expect(padAnsi('abcd', 4)).toBe('abcd');
  });
});

describe('truncateWidth', () => {
  test('returns value unchanged when it fits', () => {
    expect(truncateWidth('abc', 5)).toBe('abc');
    expect(truncateWidth('abcde', 5)).toBe('abcde');
  });

  test('truncates with ellipsis reserving one cell', () => {
    expect(truncateWidth('abcdef', 5)).toBe('abcd…');
  });

  test('counts emoji as 2 cells', () => {
    // '🤖 workspace' = 12 cells; cut to 8 → 7 cells of content + …
    expect(truncateWidth('🤖 workspace', 8)).toBe('🤖 work…');
  });

  test('does not split a wide character before the ellipsis', () => {
    // 'a🔒b' cut to 2: only 1 cell available for content, 🔒 needs 2
    expect(truncateWidth('a🔒b', 2)).toBe('a…');
  });

  test('returns empty string for maxWidth <= 1', () => {
    expect(truncateWidth('abc', 1)).toBe('');
    expect(truncateWidth('abc', 0)).toBe('');
  });
});
