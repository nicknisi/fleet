// CSI sequences, plus OSC strings (hyperlinks, titles) terminated by BEL/ST —
// an unterminated OSC (truncated capture) strips to end of string.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b(?:\[[0-9;:]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * OSC 2 "set title" sequence. Inside tmux this sets `#{pane_title}` for the
 * pane; outside tmux it sets the terminal window title. Control characters
 * are stripped so a hostile payload can't terminate the sequence early.
 */
export function oscTitle(title: string): string {
  // oxlint-disable-next-line no-control-regex
  return `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`;
}

function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || codePoint === 0x7f) return 0;
  // Zero-width: joiners, variation selectors (incl. the supplement plane),
  // and combining marks (diacriticals, kana voicing, half marks) — these
  // attach to the previous glyph and occupy no column of their own.
  if (
    codePoint === 0xfe0f ||
    (codePoint >= 0x200d && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0e) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0x3099 && codePoint <= 0x309a) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
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
    (codePoint >= 0x20000 && codePoint <= 0x3ffff)
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
    // OSC string (hyperlink, title): copy through to BEL / ST so truncation
    // can't split it mid-sequence; its bytes are zero-width.
    if (ch === '\x1b' && value[i + 1] === ']') {
      output += ch;
      output += value[i + 1]!;
      i += 2;
      while (i < value.length) {
        const next = value[i]!;
        output += next;
        i += 1;
        if (next === '\x07') break;
        if (next === '\x1b' && value[i] === '\\') {
          output += value[i]!;
          i += 1;
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
