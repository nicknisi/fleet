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

function rgb(r: number, g: number, b: number): string {
  return code(`\x1b[38;2;${r};${g};${b}m`);
}

export type StateColorKey = 'permit' | 'question' | 'done' | 'busy' | 'idle' | 'shell' | 'down';

type StatePalette = Record<StateColorKey, readonly [number, number, number]>;

// Catppuccin Mocha (dark terminals): yellow, mauve, green, peach, blue, overlay0, surface1
const MOCHA: StatePalette = {
  permit: [249, 226, 175],
  question: [203, 166, 247],
  done: [166, 227, 161],
  busy: [250, 179, 135],
  idle: [137, 180, 250],
  shell: [108, 112, 134],
  down: [69, 71, 90],
};

// Catppuccin Latte (light terminals): same roles, legible on white
const LATTE: StatePalette = {
  permit: [223, 142, 29],
  question: [136, 57, 239],
  done: [64, 160, 43],
  busy: [254, 100, 11],
  idle: [30, 102, 245],
  shell: [156, 160, 176],
  down: [188, 192, 204],
};

let activePalette: StatePalette = MOCHA;

export function setThemeMode(mode: ThemeMode): void {
  activePalette = mode === 'light' ? LATTE : MOCHA;
}

export function getThemeMode(): ThemeMode {
  return activePalette === LATTE ? 'light' : 'dark';
}

export function stateRgb(key: StateColorKey): readonly [number, number, number] {
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
  // State colors route through the active palette (Mocha/Latte per theme).
  get permit() {
    return rgb(...activePalette.permit);
  },
  get question() {
    return rgb(...activePalette.question);
  },
  get done() {
    return rgb(...activePalette.done);
  },
  get busy() {
    return rgb(...activePalette.busy);
  },
  get idle() {
    return rgb(...activePalette.idle);
  },
  get shell() {
    return rgb(...activePalette.shell);
  },
  get down() {
    return rgb(...activePalette.down);
  },
} as const;
