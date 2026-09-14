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

const RAW_KEY_CHUNK_SIZE = 1024;

export function sendRawKey(paneId: string, data: Buffer): void {
  // Decoding only the first key can turn a modified arrow into Escape or
  // discard coalesced keys. Hex mode preserves every byte, including UTF-8
  // characters split across separate terminal reads.
  // Bound each command so large reads fit within tmux's message size limit.
  for (let offset = 0; offset < data.length; offset += RAW_KEY_CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + RAW_KEY_CHUNK_SIZE);
    tmuxOrThrow(
      ['send-keys', '-t', paneId, '-H', ...Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0'))],
      'send-keys raw bytes failed',
    );
  }
}
