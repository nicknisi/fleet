export type MouseButton = 'left' | 'right' | 'middle' | 'scroll-up' | 'scroll-down' | 'other';

export interface MouseEvent {
  button: MouseButton;
  x: number;
  y: number;
  type: 'press' | 'release' | 'move';
}

/**
 * Parse a single SGR mouse event from the given buffer.
 *
 * SGR mouse mode format: `\x1b[<button;x;yM` (press/move) or `\x1b[<button;x;ym` (release).
 *
 * Button encoding (low 2 bits):
 *   0 = left, 1 = middle, 2 = right
 *   bit 5 (32) = motion
 *   bit 6 (64) = wheel (scroll-up = 64, scroll-down = 65)
 *
 * Returns null if the buffer does not start with a valid SGR mouse sequence.
 */
export function parseMouseEvent(data: Buffer): MouseEvent | null {
  // Look for ESC [ < at start.
  if (data.length < 6) return null;
  if (data[0] !== 0x1b || data[1] !== 0x5b || data[2] !== 0x3c) return null;

  // Find terminator 'M' (0x4d, press/move) or 'm' (0x6d, release).
  let end = -1;
  let isRelease = false;
  for (let i = 3; i < data.length; i += 1) {
    const b = data[i]!;
    if (b === 0x4d) {
      end = i;
      break;
    }
    if (b === 0x6d) {
      end = i;
      isRelease = true;
      break;
    }
  }
  if (end === -1) return null;

  const payload = data.subarray(3, end).toString('ascii');
  const parts = payload.split(';');
  if (parts.length !== 3) return null;

  const code = parseInt(parts[0]!, 10);
  const x = parseInt(parts[1]!, 10);
  const y = parseInt(parts[2]!, 10);
  if (Number.isNaN(code) || Number.isNaN(x) || Number.isNaN(y)) return null;

  const isMotion = (code & 0x20) !== 0;
  const isWheel = (code & 0x40) !== 0;
  const buttonBits = code & 0x03;

  let button: MouseButton;
  if (isWheel) {
    button = buttonBits === 0 ? 'scroll-up' : 'scroll-down';
  } else {
    switch (buttonBits) {
      case 0:
        button = 'left';
        break;
      case 1:
        button = 'middle';
        break;
      case 2:
        button = 'right';
        break;
      default:
        button = 'other';
    }
  }

  let type: 'press' | 'release' | 'move';
  if (isMotion) {
    type = 'move';
  } else if (isRelease) {
    type = 'release';
  } else {
    type = 'press';
  }

  return { button, x, y, type };
}

/**
 * Return true if the buffer looks like an SGR mouse event prefix (`ESC [ <`).
 * Useful for the main input loop to dispatch to `parseMouseEvent` vs `parseKeyEvent`.
 */
export function isMouseSequence(data: Buffer): boolean {
  return data.length >= 3 && data[0] === 0x1b && data[1] === 0x5b && data[2] === 0x3c;
}
