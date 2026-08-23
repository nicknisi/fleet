import type { ThemeMode } from './theme.ts';

const isTTY = process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR;
let forceNoColor = false;

export function disableColors() {
  forceNoColor = true;
}

function code(c: string): string {
  if (forceNoColor || noColor || !isTTY) return '';
  return c;
}

export type StateColorKey = 'permit' | 'question' | 'done' | 'busy' | 'idle' | 'shell' | 'down';

export type AnsiColor = { kind: 'ansi'; code: number };
export type RgbColor = { kind: 'rgb'; r: number; g: number; b: number };
export type ThemeColor = AnsiColor | RgbColor;
// Named owner contract for a complete palette: one ThemeColor per agent state.
export interface StatePalette {
  permit: ThemeColor;
  question: ThemeColor;
  done: ThemeColor;
  busy: ThemeColor;
  idle: ThemeColor;
  shell: ThemeColor;
  down: ThemeColor;
}

const rgb = (r: number, g: number, b: number): RgbColor => ({ kind: 'rgb', r, g, b });

export function serializeThemeColor(color: ThemeColor, enabled = !(forceNoColor || noColor || !isTTY)): string {
  if (!enabled) return '';
  if (color.kind === 'ansi') return `\x1b[${color.code}m`;
  return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

function stateColor(color: ThemeColor): string {
  return serializeThemeColor(color);
}

// Catppuccin Mocha (dark terminals): yellow, mauve, green, peach, blue, overlay0, surface1
const MOCHA: StatePalette = {
  permit: rgb(249, 226, 175),
  question: rgb(203, 166, 247),
  done: rgb(166, 227, 161),
  busy: rgb(250, 179, 135),
  idle: rgb(137, 180, 250),
  shell: rgb(108, 112, 134),
  down: rgb(69, 71, 90),
};

// Catppuccin Latte (light terminals): same roles, legible on white
const LATTE: StatePalette = {
  permit: rgb(223, 142, 29),
  question: rgb(136, 57, 239),
  done: rgb(64, 160, 43),
  busy: rgb(254, 100, 11),
  idle: rgb(30, 102, 245),
  shell: rgb(156, 160, 176),
  down: rgb(188, 192, 204),
};

let activePalette: StatePalette = MOCHA;
let activeMode: ThemeMode | null = 'dark';

export function setThemeMode(mode: ThemeMode): void {
  activePalette = mode === 'light' ? LATTE : MOCHA;
  activeMode = mode;
}

export function setStatePalette(palette: StatePalette): void {
  activePalette = palette;
  activeMode = null;
}

export function getThemeMode(): ThemeMode | null {
  return activeMode;
}

export function stateThemeColor(key: StateColorKey): ThemeColor {
  return activePalette[key];
}

export const C = {
  get reset() {
    return code('\x1b[0m');
  },
  get bold() {
    return code('\x1b[1m');
  },
  get dim() {
    return code('\x1b[2m');
  },
  get red() {
    return code('\x1b[0;31m');
  },
  get green() {
    return code('\x1b[0;32m');
  },
  get blue() {
    return code('\x1b[0;34m');
  },
  get purple() {
    return code('\x1b[0;35m');
  },
  get cyan() {
    return code('\x1b[0;36m');
  },
  get cyanBold() {
    return code('\x1b[1;36m');
  },
  get yellow() {
    return code('\x1b[0;33m');
  },
  get yellowBold() {
    return code('\x1b[1;33m');
  },
  get greenBold() {
    return code('\x1b[1;32m');
  },
  get whiteBold() {
    return code('\x1b[1;37m');
  },
  get gray() {
    return code('\x1b[0;90m');
  },
  get underline() {
    return code('\x1b[4m');
  },
  // State colors route through the active built-in or custom palette.
  get permit() {
    return stateColor(activePalette.permit);
  },
  get question() {
    return stateColor(activePalette.question);
  },
  get done() {
    return stateColor(activePalette.done);
  },
  get busy() {
    return stateColor(activePalette.busy);
  },
  get idle() {
    return stateColor(activePalette.idle);
  },
  get shell() {
    return stateColor(activePalette.shell);
  },
  get down() {
    return stateColor(activePalette.down);
  },
} as const;
