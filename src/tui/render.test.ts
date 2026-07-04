import { describe, expect, test, beforeAll, mock } from 'bun:test';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { disableColors } from '../terminal/colors.ts';

disableColors();

// A captured pane line with an open background SGR and NO trailing reset —
// exactly what a Claude Code diff line looks like in `capturePane` output.
const OPEN_BG = '\x1b[48;5;52m';
const CAPTURED_DIFF_LINE = `${OPEN_BG}  4 -description`;

// capturePane reads real tmux; mock it so render() gets deterministic,
// untrusted ANSI content for the preview pane.
mock.module('../tmux/sessions.ts', () => ({
  capturePane: () => [CAPTURED_DIFF_LINE],
}));

let render: typeof import('./render.ts').render;
let TuiApp: typeof import('./app.ts').TuiApp;
let TuiMode: typeof import('./app.ts').TuiMode;

beforeAll(async () => {
  ({ render } = await import('./render.ts'));
  ({ TuiApp, TuiMode } = await import('./app.ts'));
});

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

describe('render preview pane isolation', () => {
  test('open background in captured preview content is sealed before the row ends', () => {
    const app = new TuiApp();
    app.updateStates([makeState()]);
    app.mode = TuiMode.PREVIEW;

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
