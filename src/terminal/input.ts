export type KeyEvent =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'backspace' }
  | { type: 'tab' }
  | { type: 'arrow'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'ctrl'; char: string }
  | { type: 'unknown' };

export function parseKeyEvent(data: Buffer): KeyEvent {
  if (data.length === 0) return { type: 'unknown' };

  const first = data[0]!;

  // Escape sequence (arrows, etc.)
  if (first === 0x1b) {
    if (data.length === 1) return { type: 'escape' };
    if (data.length >= 3 && data[1] === 0x5b /* '[' */) {
      const final = data[2];
      switch (final) {
        case 0x41 /* A */:
          return { type: 'arrow', direction: 'up' };
        case 0x42 /* B */:
          return { type: 'arrow', direction: 'down' };
        case 0x43 /* C */:
          return { type: 'arrow', direction: 'right' };
        case 0x44 /* D */:
          return { type: 'arrow', direction: 'left' };
        default:
          return { type: 'unknown' };
      }
    }
    return { type: 'escape' };
  }

  // Enter (CR only — 0x0A/LF is Ctrl-J, handled below)
  if (first === 0x0d) return { type: 'enter' };
  // Backspace (DEL only — 0x08/BS is Ctrl-H, handled below)
  if (first === 0x7f) return { type: 'backspace' };
  if (first === 0x09) return { type: 'tab' };

  // Control characters (Ctrl-A..Ctrl-Z except CR/LF/Tab/BS handled above)
  if (first >= 0x01 && first <= 0x1a) {
    const char = String.fromCharCode(first + 0x60);
    return { type: 'ctrl', char };
  }

  // Printable ASCII + extended (multi-byte UTF-8 first byte)
  if (first >= 0x20 && first <= 0x7e) {
    return { type: 'char', char: String.fromCharCode(first) };
  }

  // UTF-8 multi-byte
  if (first >= 0xc0) {
    return { type: 'char', char: data.toString('utf8') };
  }

  return { type: 'unknown' };
}
