import { oscTitle } from './ansi.ts';

export interface TerminalSize {
  rows: number;
  cols: number;
}

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const ENABLE_MOUSE = '\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1002l\x1b[?1003l\x1b[?1006l';

let rawModeActive = false;
let altScreenActive = false;
let cursorHidden = false;
let mouseActive = false;
let cleanupRegistered = false;

export function enterRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawModeActive = true;
  }
  process.stdin.resume();
  registerCleanup();
}

export function exitRawMode(): void {
  if (rawModeActive && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    rawModeActive = false;
  }
}

export function enterAlternateScreen(): void {
  process.stdout.write(ENTER_ALT_SCREEN);
  altScreenActive = true;
}

export function leaveAlternateScreen(): void {
  if (altScreenActive) {
    process.stdout.write(LEAVE_ALT_SCREEN);
    altScreenActive = false;
  }
}

export function hideCursor(): void {
  process.stdout.write(HIDE_CURSOR);
  cursorHidden = true;
}

export function showCursor(): void {
  if (cursorHidden) {
    process.stdout.write(SHOW_CURSOR);
    cursorHidden = false;
  }
}

export function enableMouse(): void {
  process.stdout.write(ENABLE_MOUSE);
  mouseActive = true;
}

export function disableMouse(): void {
  if (mouseActive) {
    process.stdout.write(DISABLE_MOUSE);
    mouseActive = false;
  }
}

let lastTitle: string | null = null;

// Sets the pane title (OSC 2) — inside tmux this is #{pane_title}, which the
// user's automatic-rename hook can prefer over command+cwd naming.
export function setPaneTitle(title: string): void {
  if (title === lastTitle) return;
  lastTitle = title;
  process.stdout.write(oscTitle(title));
}

export function clearPaneTitle(): void {
  if (lastTitle === null) return;
  lastTitle = null;
  process.stdout.write(oscTitle(''));
}

export function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function clearScreen(): void {
  process.stdout.write(CLEAR_SCREEN);
}

export function getTerminalSize(): TerminalSize {
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
}

export function restore(): void {
  clearPaneTitle();
  disableMouse();
  showCursor();
  leaveAlternateScreen();
  exitRawMode();
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    restore();
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    cleanup();
    console.error(reason);
    process.exit(1);
  });
}

export async function withTerminal<T>(fn: () => Promise<T> | T): Promise<T> {
  enterAlternateScreen();
  hideCursor();
  enterRawMode();
  try {
    return await fn();
  } finally {
    restore();
  }
}
