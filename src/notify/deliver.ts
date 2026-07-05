// Silent, best-effort desktop toast. Never sounds, never throws, and no-ops when
// unsupported — a notifier must never crash the render loop (fleet's
// never-crash-the-host principle). See the no-audible-cue constraint: no
// `sound name` (macOS) / no `-u critical` (Linux), so these stay silent.

// AppleScript-escape a string into a double-quoted literal. osascript is spawned
// via argv (no shell), so only AppleScript-level escaping is needed: backslash and
// quote are escaped; control chars are neutralized (a raw newline is a syntax
// error inside a "..." literal). Session/window names can contain quotes.
function q(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ');
  return `"${escaped}"`;
}

// macOS: osascript display notification WITHOUT `sound name` => silent.
// Linux: notify-send only when a desktop session is present.
export function deliverDesktop(title: string, body: string): void {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${q(body)} with title ${q(title)}`; // no sound
      Bun.spawn(['osascript', '-e', script], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    if (process.platform === 'linux') {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // headless/SSH => no-op
      Bun.spawn(['notify-send', '-u', 'normal', title, body], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    // other platforms: no-op
  } catch {
    /* missing binary / spawn failure: silently ignore */
  }
}
