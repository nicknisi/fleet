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
  // Catppuccin Mocha palette for state colors
  get permit() {
    return rgb(249, 226, 175);
  }, // #f9e2af yellow
  get question() {
    return rgb(203, 166, 247);
  }, // #cba6f7 mauve
  get done() {
    return rgb(166, 227, 161);
  }, // #a6e3a1 green
  get busy() {
    return rgb(250, 179, 135);
  }, // #fab387 peach
  get idle() {
    return rgb(137, 180, 250);
  }, // #89b4fa blue
  get shell() {
    return rgb(108, 112, 134);
  }, // #6c7086 overlay0
  get down() {
    return rgb(69, 71, 90);
  }, // #45475a surface1
} as const;
