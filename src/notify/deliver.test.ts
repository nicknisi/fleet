import { describe, expect, test } from 'bun:test';
import {
  buildClickCommand,
  deliverDesktop,
  helperPath,
  planDarwinDelivery,
  sanitizeNotificationText,
  truncateText,
} from './deliver.ts';

describe('sanitizeNotificationText', () => {
  test('strips CSI sequences (ESC [ ... final byte)', () => {
    expect(sanitizeNotificationText('\x1b[31mred\x1b[0m text')).toBe('red text');
    expect(sanitizeNotificationText('\x1b[1;31;42mhi\x1b[0m')).toBe('hi');
  });

  test('strips OSC strings terminated by BEL', () => {
    expect(sanitizeNotificationText('\x1b]0;secret\x07visible')).toBe('visible');
  });

  test('strips OSC strings terminated by ST (ESC \\)', () => {
    expect(sanitizeNotificationText('\x1b]8;;https://example.test\x1b\\link')).toBe('link');
  });

  test('strips DCS/SOS/PM/APC control strings', () => {
    expect(sanitizeNotificationText('\x1bPqping\x1b\\pong')).toBe('pong');
    expect(sanitizeNotificationText('\x1b_X\x1b\\y')).toBe('y');
  });

  test('strips lone C1 CSI (0x9b)', () => {
    // 0x9b followed by parameters (31) and a final byte (m, 0x6d) — the whole
    // sequence is consumed; 'rest' survives.
    expect(sanitizeNotificationText('\u009b31mrest')).toBe('rest');
  });

  test('drops other control chars', () => {
    expect(sanitizeNotificationText('a\x00b\x07c')).toBe('abc');
  });

  test('maps whitespace to single spaces and collapses runs', () => {
    expect(sanitizeNotificationText('a\t\n b   c')).toBe('a b c');
  });

  test('combined real-world pane title', () => {
    const input = '\x1b]0;secret\x07\x1b[31mImplement\x1b[0m\nnow';
    expect(sanitizeNotificationText(input)).toBe('Implement now');
  });

  test('handles empty and whitespace-only input', () => {
    expect(sanitizeNotificationText('')).toBe('');
    expect(sanitizeNotificationText('   \n\t  ')).toBe('');
  });

  test('preserves unicode', () => {
    expect(sanitizeNotificationText('界 🙂 codex')).toBe('界 🙂 codex');
  });
});

describe('truncateText', () => {
  test('under limit returns unchanged', () => {
    expect(truncateText('abc', 80)).toBe('abc');
  });

  test('at limit returns unchanged', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });

  test('over limit adds ellipsis and caps at limit (char-based)', () => {
    expect(truncateText('abcdef', 4)).toBe('abc…');
  });

  test('is unicode-safe (counts code points, not UTF-16 units)', () => {
    const s = '界'.repeat(100);
    const out = truncateText(s, 5);
    expect(Array.from(out)).toHaveLength(5);
    expect(out.endsWith('…')).toBe(true);
  });

  test('title/body limits are 80 and 240', () => {
    const long = '🙂'.repeat(300);
    expect(Array.from(truncateText(long, 80))).toHaveLength(80);
    expect(Array.from(truncateText(long, 240))).toHaveLength(240);
  });
});

describe('buildClickCommand', () => {
  test('quotes every argument and places paneId before socket', () => {
    expect(buildClickCommand('/usr/local/bin/fleet', '%7', '/tmp/sock', 'com.mitchellh.ghostty')).toBe(
      "'/usr/local/bin/fleet' 'notification-open' '%7' '/tmp/sock' 'com.mitchellh.ghostty'",
    );
  });

  test('shell-quotes embedded single quotes', () => {
    expect(buildClickCommand("/tmp/agent's mon", '%7', '/tmp/tmux socket', 'com.apple.Terminal')).toBe(
      "'/tmp/agent'\"'\"'s mon' 'notification-open' '%7' '/tmp/tmux socket' 'com.apple.Terminal'",
    );
  });

  test('passes through "-" placeholders untouched (still quoted)', () => {
    expect(buildClickCommand('/exe', '%1', '-', '-')).toBe("'/exe' 'notification-open' '%1' '-' '-'");
  });

  test('spaces are contained within the quotes', () => {
    expect(buildClickCommand('/a b/c', '%2', '/path with space', 'bundle id')).toBe(
      "'/a b/c' 'notification-open' '%2' '/path with space' 'bundle id'",
    );
  });
});

describe('helperPath', () => {
  test('resolves under the injected home', () => {
    expect(helperPath('/Users/me')).toBe('/Users/me/Applications/FleetNotifier.app/Contents/MacOS/fleet-notifier');
  });
});

describe('planDarwinDelivery — ladder decision', () => {
  const sanitized = (s: string) => s; // planner receives already-sanitized text

  test('helper present → helper spec with [title, body, clickCommand], detached', () => {
    const home = '/Users/me';
    const spec = planDarwinDelivery(
      sanitized('Codex finished'),
      sanitized('context'),
      "'/exe' 'notification-open' '%7' '-' '-'",
      home,
      () => true,
    );
    expect(spec.program).toBe(helperPath(home));
    expect(spec.args).toEqual(['Codex finished', 'context', "'/exe' 'notification-open' '%7' '-' '-'"]);
    expect(spec.detached).toBe(true);
    expect(spec.stdin).toBeUndefined();
  });

  test('helper present without click command → helper spec with only [title, body]', () => {
    const spec = planDarwinDelivery('t', 'b', null, '/Users/me', () => true);
    expect(spec.program).toBe(helperPath('/Users/me'));
    expect(spec.args).toEqual(['t', 'b']);
    expect(spec.detached).toBe(true);
  });

  test('helper absent → silent osascript spec (no sound, no click)', () => {
    const spec = planDarwinDelivery(
      'Codex finished',
      'context',
      "'/exe' 'notification-open'",
      '/Users/me',
      () => false,
    );
    expect(spec.program).toBe('osascript');
    expect(spec.args[0]).toBe('-e');
    const script = spec.args[1]!;
    expect(script).toContain('display notification');
    expect(script).toContain('with title');
    expect(script).not.toContain('sound name'); // silent
    expect(spec.detached).toBeUndefined();
  });

  test('osascript fallback AppleScript-quotes the title and body', () => {
    const spec = planDarwinDelivery('He said "hi"', 'body\\line', null, '/Users/me', () => false);
    const script = spec.args[1]!;
    expect(script).toContain('"He said \\"hi\\""');
    expect(script).toContain('"body\\\\line"');
  });
});

describe('deliverDesktop — never throws', () => {
  // Guard against the helper-spawn path throwing on non-darwin; we only assert
  // it doesn't throw. No macOS UI is exercised here.
  test('unknown platform is a no-op (does not throw)', () => {
    const before = process.platform;
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      expect(() => deliverDesktop('t', 'b', '%1')).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', { value: before, configurable: true });
    }
  });
});
