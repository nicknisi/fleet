import { tmuxOrThrow } from './ipc.ts';

export function sendKeys(paneId: string, text: string): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) {
      tmuxOrThrow(['send-keys', '-t', paneId, 'M-Enter'], 'send-keys M-Enter failed');
    }
    tmuxOrThrow(['send-keys', '-t', paneId, '-l', line], 'send-keys failed');
  }
  tmuxOrThrow(['send-keys', '-t', paneId, 'Enter'], 'send-keys Enter failed');
}

const SPECIAL_KEY_MAP: Record<number, string> = {
  0x0d: 'Enter',
  0x7f: 'BSpace',
  0x09: 'Tab',
  0x1b: 'Escape',
};

export function sendRawKey(paneId: string, data: Buffer): void {
  const first = data[0];
  if (first === undefined) return;

  if (first === 0x1b && data.length >= 3 && data[1] === 0x5b) {
    const arrows: Record<number, string> = {
      0x41: 'Up',
      0x42: 'Down',
      0x43: 'Right',
      0x44: 'Left',
    };
    const arrow = data[2] !== undefined ? arrows[data[2]] : undefined;
    if (arrow) {
      tmuxOrThrow(['send-keys', '-t', paneId, arrow], 'send-keys arrow failed');
      return;
    }
  }

  const special = SPECIAL_KEY_MAP[first];
  if (special) {
    tmuxOrThrow(['send-keys', '-t', paneId, special], `send-keys ${special} failed`);
    return;
  }

  if (first >= 0x01 && first <= 0x1a) {
    const letter = String.fromCharCode(first + 0x60);
    tmuxOrThrow(['send-keys', '-t', paneId, `C-${letter}`], `send-keys C-${letter} failed`);
    return;
  }

  tmuxOrThrow(['send-keys', '-t', paneId, '-l', data.toString('utf8')], 'send-keys literal failed');
}
