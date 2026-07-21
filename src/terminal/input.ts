export type KeyEvent =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'backspace' }
  | { type: 'tab' }
  | { type: 'arrow'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'ctrl'; char: string }
  | { type: 'unknown' };

// Parse one key event starting at `offset`, returning the event and the offset
// just past its bytes — so a read that coalesced several keystrokes (fast
// typing, SSH batching, paste) yields every key instead of only the first.
function parseOneKey(data: Buffer, offset: number): { event: KeyEvent; next: number } {
  const first = data[offset]!;

  // Escape sequence (arrows, other CSI)
  if (first === 0x1b) {
    if (data[offset + 1] === 0x5b /* '[' */) {
      // Consume the full CSI sequence: parameters, then a final byte @-~.
      let i = offset + 2;
      while (i < data.length) {
        const b = data[i]!;
        i++;
        if (b >= 0x40 && b <= 0x7e) {
          if (i - offset === 3) {
            switch (b) {
              case 0x41 /* A */:
                return { event: { type: 'arrow', direction: 'up' }, next: i };
              case 0x42 /* B */:
                return { event: { type: 'arrow', direction: 'down' }, next: i };
              case 0x43 /* C */:
                return { event: { type: 'arrow', direction: 'right' }, next: i };
              case 0x44 /* D */:
                return { event: { type: 'arrow', direction: 'left' }, next: i };
            }
          }
          return { event: { type: 'unknown' }, next: i };
        }
      }
      // Incomplete CSI at end of buffer — treat as escape, drop the tail.
      return { event: { type: 'escape' }, next: data.length };
    }
    return { event: { type: 'escape' }, next: offset + 1 };
  }

  // Enter (CR only — 0x0A/LF is Ctrl-J, handled below)
  if (first === 0x0d) return { event: { type: 'enter' }, next: offset + 1 };
  // Backspace (DEL only — 0x08/BS is Ctrl-H, handled below)
  if (first === 0x7f) return { event: { type: 'backspace' }, next: offset + 1 };
  if (first === 0x09) return { event: { type: 'tab' }, next: offset + 1 };

  // Control characters (Ctrl-A..Ctrl-Z except CR/Tab handled above)
  if (first >= 0x01 && first <= 0x1a) {
    return { event: { type: 'ctrl', char: String.fromCharCode(first + 0x60) }, next: offset + 1 };
  }

  // Printable ASCII
  if (first >= 0x20 && first <= 0x7e) {
    return { event: { type: 'char', char: String.fromCharCode(first) }, next: offset + 1 };
  }

  // UTF-8 multi-byte lead — length from the lead byte, clamped to the buffer.
  if (first >= 0xc0) {
    const len = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : 2;
    const end = Math.min(offset + len, data.length);
    return { event: { type: 'char', char: data.subarray(offset, end).toString('utf8') }, next: end };
  }

  return { event: { type: 'unknown' }, next: offset + 1 };
}

export function parseKeyEvents(data: Buffer): KeyEvent[] {
  const events: KeyEvent[] = [];
  let offset = 0;
  while (offset < data.length) {
    const { event, next } = parseOneKey(data, offset);
    events.push(event);
    offset = next;
  }
  return events;
}

export function parseKeyEvent(data: Buffer): KeyEvent {
  if (data.length === 0) return { type: 'unknown' };
  return parseOneKey(data, 0).event;
}
