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
