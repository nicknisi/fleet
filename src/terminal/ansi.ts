// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;:]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || codePoint === 0x7f) return 0;
  // Zero-width joiners, variation selectors.
  if (
    codePoint === 0xfe0f ||
    (codePoint >= 0x200d && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0e)
  )
    return 0;
  // Wide: CJK, emoji, fullwidth forms.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
    return 2;
  return 1;
}

export function visibleLength(value: string): number {
  const stripped = stripAnsi(value);
  let width = 0;
  for (const ch of stripped) {
    width += charWidth(ch.codePointAt(0)!);
  }
  return width;
}

/**
 * Pad a string with trailing spaces up to `width` visible terminal columns.
 * Never truncates — callers truncate first.
 */
export function padAnsi(value: string, width: number): string {
  const pad = width - visibleLength(value);
  return pad > 0 ? value + ' '.repeat(pad) : value;
}

/**
 * Truncate plain text to `maxWidth` visible terminal columns, appending `…`
 * (1 cell) when cut. Accounts for wide characters (emoji, CJK).
 */
export function truncateWidth(value: string, maxWidth: number): string {
  if (visibleLength(value) <= maxWidth) return value;
  if (maxWidth <= 1) return '';
  return truncateAnsi(value, maxWidth - 1) + '…';
}

/**
 * Truncate a string to `maxWidth` visible terminal columns, preserving ANSI
 * escape sequences. Accounts for wide characters (emoji, CJK).
 */
export function truncateAnsi(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }

  let output = '';
  let visible = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '\x1b' && value[i + 1] === '[') {
      output += ch;
      output += value[i + 1]!;
      i += 2;
      while (i < value.length) {
        const next = value[i]!;
        output += next;
        i += 1;
        const code = next.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
      continue;
    }

    const cp = value.codePointAt(i)!;
    const w = charWidth(cp);
    if (visible + w > maxWidth) {
      break;
    }

    if (cp > 0xffff) {
      output += value[i]! + value[i + 1]!;
      i += 2;
    } else {
      output += ch;
      i += 1;
    }
    visible += w;
  }

  return output;
}
