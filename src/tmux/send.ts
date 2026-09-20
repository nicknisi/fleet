import { tmuxOrThrow } from './ipc.ts';

export function sendKeys(paneId: string, text: string): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) {
      tmuxOrThrow(['send-keys', '-t', paneId, 'M-Enter'], 'send-keys M-Enter failed');
    }
    // `--` ends option parsing: a line starting with `-` (markdown bullet,
    // CLI flag) would otherwise be read as a send-keys option and fail.
    tmuxOrThrow(['send-keys', '-t', paneId, '-l', '--', line], 'send-keys failed');
  }
  tmuxOrThrow(['send-keys', '-t', paneId, 'Enter'], 'send-keys Enter failed');
}

// Send a sequence of tmux key NAMES (e.g. ['1'], ['Enter'], ['Escape']) — the
// resolved answer to a permission dialog (see state/permit-keys.ts). No -l:
// tmux translates named keys itself; single characters pass through as those
// keys. `--` guards a hypothetical key spec starting with '-'.
export function sendKeyNames(paneId: string, keys: string[]): void {
  for (const key of keys) {
    tmuxOrThrow(['send-keys', '-t', paneId, '--', key], 'send-keys named key failed');
  }
}

const KEYS_PER_COMMAND = 256;
const SPECIAL_KEY_NAMES = new Map<number, string>([
  [0x0d, 'Enter'],
  [0x7f, 'BSpace'],
  [0x09, 'Tab'],
]);
const ARROW_NAMES = new Map<number, string>([
  [0x41, 'Up'],
  [0x42, 'Down'],
  [0x43, 'Right'],
  [0x44, 'Left'],
]);

export function sendRawKey(paneId: string, data: Buffer, expectedPid?: number): void {
  const send = (args: string[], label: string) => {
    if (expectedPid === undefined) {
      tmuxOrThrow(args, label);
      return;
    }
    if (!/^%\d+$/.test(paneId) || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
      throw new Error('Invalid passthrough target');
    }
    // Raw batches contain only hex bytes / fixed tmux key names. Check process
    // identity inside tmux's command queue, with no additional read or fork.
    // A respawn between observer ticks must not receive the previous agent's input.
    tmuxOrThrow(['if-shell', '-F', '-t', paneId, `#{==:#{pane_pid},${expectedPid}}`, args.join(' ')], label);
  };
  // Keep tmux's encoding for recognized leading keys: named arrows work in
  // copy mode and adapt to the target's application cursor mode. Consume the
  // whole recognized prefix rather than dropping everything after its first key.
  let offset = 0;
  while (offset < data.length) {
    const keys: string[] = [];
    while (offset < data.length && keys.length < KEYS_PER_COMMAND) {
      const first = data[offset]!;
      const third = data[offset + 2];
      const arrow =
        first === 0x1b && data[offset + 1] === 0x5b && third !== undefined ? ARROW_NAMES.get(third) : undefined;
      const key =
        arrow ??
        SPECIAL_KEY_NAMES.get(first) ??
        (first >= 0x01 && first <= 0x1a ? `C-${String.fromCharCode(first + 0x60)}` : undefined);
      if (key === undefined) break;
      keys.push(key);
      offset += arrow === undefined ? 1 : 3;
    }
    if (keys.length === 0) break;
    send(['send-keys', '-t', paneId, '--', ...keys], 'send-keys named keys failed');
  }

  // Forward the rest unchanged. In particular, an unrecognized escape
  // sequence must not become a bare Escape, and partial UTF-8 must not be
  // decoded. Leave escape/paste payloads opaque after this point.
  // Bound both paths so large reads fit within tmux's message size limit.
  for (; offset < data.length; offset += KEYS_PER_COMMAND) {
    const chunk = data.subarray(offset, offset + KEYS_PER_COMMAND);
    send(
      ['send-keys', '-t', paneId, '-H', ...Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0'))],
      'send-keys raw bytes failed',
    );
  }
}
