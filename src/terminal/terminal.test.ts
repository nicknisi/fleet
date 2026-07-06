import { afterEach, describe, expect, test } from 'bun:test';
import { clearPaneTitle, restore, setPaneTitle } from './terminal.ts';

// Capture stdout writes without leaking escape sequences into test output.
function captureWrites(fn: () => void): string[] {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return writes;
}

afterEach(() => {
  captureWrites(() => clearPaneTitle());
});

describe('setPaneTitle', () => {
  test('emits an OSC 2 sequence', () => {
    const writes = captureWrites(() => setPaneTitle('fleet'));
    expect(writes).toEqual(['\x1b]2;fleet\x07']);
  });

  test('skips the write when the title is unchanged', () => {
    const writes = captureWrites(() => {
      setPaneTitle('fleet');
      setPaneTitle('fleet');
    });
    expect(writes).toEqual(['\x1b]2;fleet\x07']);
  });

  test('emits again when the title changes', () => {
    const writes = captureWrites(() => {
      setPaneTitle('fleet');
      setPaneTitle('fleet — 1 working');
    });
    expect(writes).toEqual(['\x1b]2;fleet\x07', '\x1b]2;fleet — 1 working\x07']);
  });
});

describe('clearPaneTitle', () => {
  test('resets the title after one was set', () => {
    const writes = captureWrites(() => {
      setPaneTitle('fleet');
      clearPaneTitle();
    });
    expect(writes).toEqual(['\x1b]2;fleet\x07', '\x1b]2;\x07']);
  });

  test('does nothing when no title was ever set', () => {
    const writes = captureWrites(() => clearPaneTitle());
    expect(writes).toEqual([]);
  });
});

describe('restore', () => {
  test('clears a set pane title', () => {
    const writes = captureWrites(() => {
      setPaneTitle('fleet');
      restore();
    });
    expect(writes).toContain('\x1b]2;\x07');
  });
});
