// Silent, best-effort desktop toast. Never sounds, never throws, and no-ops when
// unsupported — a notifier must never crash the render loop (fleet's
// never-crash-the-host principle). See the no-audible-cue constraint: no
// `sound name` (macOS) / no `-u critical` (Linux), so these stay silent.
//
// macOS delivery is a ladder: when the native FleetNotifier helper is installed
// (~/Applications/FleetNotifier.app/Contents/MacOS/fleet-notifier) it is spawned
// detached with [title, body, clickCommand] — the helper posts through
// UNUserNotificationCenter and runs the click command (a `fleet notification-open
// <paneId> <socket> <bundle>` invocation) when the body is clicked. An installed
// helper is authoritative: a failure (typically denied permission) means silence,
// never an AppleScript end-run. When the helper is absent, the silent osascript
// path is used unchanged. The helper path is re-resolved on every delivery so
// installing the app takes effect without restarting the sidebar.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const HELPER_REL = 'Applications/FleetNotifier.app/Contents/MacOS/fleet-notifier';
const TITLE_LIMIT = 80;
const BODY_LIMIT = 240;

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

// Shell-quote a single argument into a POSIX single-quoted literal, escaping any
// embedded single quotes as '\' + "'" + '\' (i.e. the standard '"'"' trick) so
// the click command is safe to feed to /bin/sh -c on click.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

// Strip terminal control sequences from notification text so a hostile or noisy
// pane title can't inject escapes into the toast. Ports the Rust sanitize():
//   - ESC [ ... final byte 0x40–0x7e  → CSI sequence, dropped
//   - ESC ]/P/X/^/_ ... terminated by BEL or ESC \ → OSC/DCS/SOS/PM/APC, dropped
//   - lone 0x9b (C1 CSI) → CSI sequence, dropped
//   - whitespace → single space; other control chars dropped
//   - runs of whitespace collapsed to a single space
export function sanitizeNotificationText(s: string): string {
  const chars = Array.from(s);
  let clean = '';
  let i = 0;
  const n = chars.length;
  const isWs = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
  // oxlint-disable-next-line no-control-regex
  const isControl = (ch: string) => {
    const c = ch.codePointAt(0)!;
    return c < 0x20 || (c >= 0x7f && c < 0xa0);
  };
  const skipCsi = () => {
    while (i < n) {
      const ch = chars[i]!;
      i += 1;
      const c = ch.codePointAt(0)!;
      if (c >= 0x40 && c <= 0x7e) break;
    }
  };
  const skipControlString = () => {
    while (i < n) {
      const ch = chars[i]!;
      i += 1;
      if (ch === '\x07') break;
      if (ch === '\x1b') {
        if (i < n && chars[i] === '\\') {
          i += 1;
          break;
        }
      }
    }
  };
  while (i < n) {
    const ch = chars[i]!;
    i += 1;
    if (ch === '\x1b') {
      if (i < n) {
        const next = chars[i]!;
        if (next === '[') {
          i += 1;
          skipCsi();
        } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
          i += 1;
          skipControlString();
        }
      }
    } else if (ch === '\x9b') {
      skipCsi();
    } else if (isWs(ch)) {
      clean += ' ';
    } else if (!isControl(ch)) {
      clean += ch;
    }
  }
  return clean.trim().replace(/\s+/g, ' ');
}

// Char-based truncation with a trailing ellipsis when the text exceeds the limit.
export function truncateText(s: string, limit: number): string {
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  const ell = '…';
  const keep = Math.max(0, limit - ell.length);
  return chars.slice(0, keep).join('') + ell;
}

// Build the click command the helper runs when the notification body is clicked:
// `<fleet-exe> notification-open <paneId> <socketPath> <terminalBundleId>`, every
// argument shell-quoted. The helper invokes it via `/bin/sh -c` on click.
export function buildClickCommand(fleetExe: string, paneId: string, socket: string, bundle: string): string {
  return [fleetExe, 'notification-open', paneId, socket, bundle].map(shellQuote).join(' ');
}

// Resolve the helper path under a (possibly injected) home directory.
export function helperPath(home: string): string {
  return `${home}/${HELPER_REL}`;
}

// First comma-field of $TMUX, or '-' when unset/empty (matches the sibling
// notification-open CLI's contract).
function tmuxSocket(env: NodeJS.ProcessEnv): string {
  const tmux = env.TMUX;
  if (!tmux) return '-';
  const first = tmux.split(',')[0];
  return first && first.length > 0 ? first : '-';
}

function terminalBundle(env: NodeJS.ProcessEnv): string {
  return env.__CFBundleIdentifier ?? '-';
}

export interface CommandSpec {
  program: string;
  args: string[];
  stdin?: string;
  detached?: boolean;
}

// Pure planner for the macOS delivery ladder. Returns the command to spawn:
// the native helper (detached, with click command) when its binary exists, or
// the silent osascript fallback otherwise. `exists` is injected so tests can
// drive both branches without touching the filesystem.
export function planDarwinDelivery(
  title: string,
  body: string,
  clickCommand: string | null,
  home: string,
  exists: (path: string) => boolean,
): CommandSpec {
  const helper = helperPath(home);
  if (exists(helper)) {
    const args = [title, body];
    if (clickCommand != null) args.push(clickCommand);
    return { program: helper, args, detached: true };
  }
  // Silent osascript fallback — no `sound name`, no click handling.
  const script = `display notification ${q(body)} with title ${q(title)}`; // no sound
  return { program: 'osascript', args: ['-e', script] };
}

// Thin spawn shell around a CommandSpec. Never throws; swallow spawn errors.
function runSpec(spec: CommandSpec): void {
  const child = Bun.spawn({
    cmd: [spec.program, ...spec.args],
    stdin: spec.stdin != null ? 'pipe' : 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: spec.detached ?? false,
  });
  if (spec.stdin != null) {
    try {
      child.stdin?.write(spec.stdin);
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  }
  if (spec.detached) {
    try {
      child.unref();
    } catch {
      /* ignore */
    }
  }
}

// macOS: helper ladder if installed, else silent osascript.
// Linux: notify-send only when a desktop session is present.
export function deliverDesktop(title: string, body: string, paneId: string): void {
  try {
    if (process.platform === 'darwin') {
      const safeTitle = truncateText(sanitizeNotificationText(title), TITLE_LIMIT);
      const safeBody = truncateText(sanitizeNotificationText(body), BODY_LIMIT);
      const click = buildClickCommand(process.execPath, paneId, tmuxSocket(process.env), terminalBundle(process.env));
      const spec = planDarwinDelivery(safeTitle, safeBody, click, homedir(), existsSync);
      runSpec(spec);
      return;
    }
    if (process.platform === 'linux') {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // headless/SSH => no-op
      const safeTitle = truncateText(sanitizeNotificationText(title), TITLE_LIMIT);
      const safeBody = truncateText(sanitizeNotificationText(body), BODY_LIMIT);
      Bun.spawn(['notify-send', '-u', 'normal', safeTitle, safeBody], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    // other platforms: no-op
  } catch {
    /* missing binary / spawn failure: silently ignore */
  }
}
