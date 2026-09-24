import { describe, expect, test } from 'bun:test';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { disableColors } from '../terminal/colors.ts';
import { TuiApp, TuiMode } from './app.ts';
import { render } from './render.ts';

disableColors();

// A captured pane line with an open background SGR and NO trailing reset —
// exactly what a Claude Code diff line looks like in `capturePane` output.
const OPEN_BG = '\x1b[48;5;52m';
const CAPTURED_DIFF_LINE = `${OPEN_BG}  4 -description`;

const makeState = (): AgentState => ({
  paneId: '%1',
  paneNum: 1,
  session: 'agent-one',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.BUSY,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
});

describe('render grouped dashboard frame', () => {
  test('grouped session renders a header line and indented window rows in the frame', () => {
    const app = new TuiApp();
    app.updateStates([makeState(), { ...makeState(), paneId: '%2', window: 'other' }]);

    const out = render(app, { cols: 100, rows: 40 });
    // oxlint-disable-next-line no-control-regex
    const stripped = out.replace(/\x1b\[[0-9;:]*[@-~]/g, '');

    expect(stripped).toContain('agent-one · 2 agents');
    expect(stripped).toContain('  main');
    expect(stripped).toContain('  other');
  });
});

test('each frame is one synchronized update with the cursor hidden until the caret is placed', () => {
  const app = new TuiApp();
  app.updateStates([makeState()]);
  const frame = render(app, { cols: 100, rows: 40 });
  expect(frame.startsWith('\x1b[?2026h\x1b[?25l\x1b[H')).toBe(true);
  expect(frame.endsWith('\x1b[?25l\x1b[?2026l')).toBe(true);
  const tiny = render(app, { cols: 10, rows: 4 });
  expect(tiny.startsWith('\x1b[?2026h\x1b[?25l')).toBe(true);
  expect(tiny.endsWith('\x1b[?2026l')).toBe(true);

  app.mode = TuiMode.PREVIEW;
  app.enterPassthrough();
  app.preview = { paneId: '%1', screen: 'prompt\n', cursor: { x: 3, y: 0 }, at: 0 };
  const live = render(app, { cols: 100, rows: 40 });
  // The only cursor show is the last thing drawn, after the caret is placed.
  expect(live.split('\x1b[?25h')).toHaveLength(2);
  // oxlint-disable-next-line no-control-regex
  expect(live).toMatch(/\x1b\[\d+;\d+H\x1b\[\?25h\x1b\[\?2026l$/);
});

test('narrow action dialogs cannot wrap the frame or hide the pinned pane id', async () => {
  const { visibleLength } = await import('../terminal/ansi.ts');
  const app = new TuiApp();
  app.updateStates([
    { ...makeState(), session: 'a-very-long-session-name-that-exceeds-sidebar-width', status: AgentStatus.IDLE },
  ]);
  app.enterSend();
  app.sendBuffer = 'a'.repeat(80);
  const frame = render(app, { cols: 34, rows: 30 });
  expect(frame).toContain('Send to %1:');
  expect(frame).toContain('cancel');
  expect(frame).not.toContain('quit');
  for (const line of frame.split('\r\n')) expect(visibleLength(line)).toBeLessThanOrEqual(34);
});

describe('render preview pane isolation', () => {
  test('open background in captured preview content is sealed before the row ends', () => {
    const app = new TuiApp();
    app.updateStates([makeState()]);
    app.mode = TuiMode.PREVIEW;
    app.preview = { paneId: '%1', screen: CAPTURED_DIFF_LINE + '\n', cursor: null, at: 0 };

    const out = render(app, { cols: 100, rows: 40 });

    // The injected diff line must appear in the preview column.
    const idx = out.indexOf(OPEN_BG);
    expect(idx).toBeGreaterThan(-1);

    // Within that row (up to its line terminator), the pen MUST be reset so the
    // background can't bleed through `\x1b[K` or into the next row's list column.
    const afterBg = out.slice(idx);
    const rowEnd = afterBg.indexOf('\r\n');
    const row = rowEnd === -1 ? afterBg : afterBg.slice(0, rowEnd);
    expect(row).toContain('\x1b[0m');
  });
});

describe('render preview divider alignment', () => {
  test('divider stays in one column when window names carry surrogate-pair glyphs', async () => {
    const { visibleLength } = await import('../terminal/ansi.ts');
    const app = new TuiApp();
    // 󱙺 (U+F167A) is a plane-15 nerd-font glyph: 2 UTF-16 code units but 1
    // terminal column — exactly the shape that skews code-unit padding.
    app.updateStates([
      { ...makeState(), window: '󱙺 one' },
      { ...makeState(), paneId: '%2', window: 'two' },
    ]);
    app.mode = TuiMode.PREVIEW;

    const out = render(app, { cols: 100, rows: 40 });
    const columns = new Set<number>();
    for (const line of out.split('\r\n')) {
      const bar = line.indexOf('│');
      if (bar === -1) continue;
      columns.add(visibleLength(line.slice(0, bar)));
    }
    expect(columns.size).toBe(1);
  });
});
