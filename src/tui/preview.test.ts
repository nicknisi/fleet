import { describe, expect, test } from 'bun:test';
import {
  previewActions,
  readPreview,
  renderPreview,
  renderPreviewWithCursor,
  type PreviewSnapshot,
} from './preview.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { disableColors } from '../terminal/colors.ts';

disableColors();
const makeState = (status: AgentStatus): AgentState => ({
  paneId: '%1',
  paneNum: 1,
  session: 'test',
  window: 'main',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
});
const snapshot = (cursor: PreviewSnapshot['cursor'], paneId = '%1'): PreviewSnapshot => ({
  paneId,
  screen: 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n',
  cursor,
  at: 0,
});

describe('previewActions', () => {
  test('PERMIT shows approve/deny', () => {
    expect(previewActions(makeState(AgentStatus.PERMIT))).toContain('approve');
    expect(previewActions(makeState(AgentStatus.PERMIT))).toContain('deny');
  });
  test('QUESTION only offers inline answer, not an unsafe send', () => {
    expect(previewActions(makeState(AgentStatus.QUESTION))).toContain('answer inline');
    expect(previewActions(makeState(AgentStatus.QUESTION))).not.toContain('send');
  });
  test('DONE shows passthrough and send', () => {
    expect(previewActions(makeState(AgentStatus.DONE))).toContain('passthrough');
    expect(previewActions(makeState(AgentStatus.DONE))).toContain('send prompt');
  });
  test('BUSY shows passthrough; SHELL has no shortcut', () => {
    expect(previewActions(makeState(AgentStatus.BUSY))).toContain('passthrough');
    expect(previewActions(makeState(AgentStatus.SHELL))).toBe('');
  });
});

describe('pure preview rendering', () => {
  test('renders its identity without reading tmux', () => {
    const lines = renderPreview({ ...makeState(AgentStatus.DONE), window: 'editor' }, 80, 20);
    expect(lines[0]).toContain('editor [test] · READY');
    expect(lines.join('\n')).toContain('Loading preview');
  });
  test('collapses to the bare session when the window adds nothing', () => {
    expect(renderPreview({ ...makeState(AgentStatus.DONE), window: 'test' }, 80, 20)[0]).toContain('test · READY');
  });
  test('maps cursor through the clipped rows', () => {
    const result = renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 5, true, 0, snapshot({ x: 7, y: 6 }));
    expect(result.cursor).toEqual({ row: 3, col: 7 });
    expect(result.lines[2]).toBe('l5');
  });
  test('a caret above the bottom rows brings the window to it', () => {
    const result = renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 5, true, 0, snapshot({ x: 0, y: 2 }));
    expect(result.cursor).toEqual({ row: 2, col: 0 });
    expect(result.lines.slice(2)).toEqual(['l2', 'l3', 'l4']);
  });
  test('a preview with no content rows shows no pane text and no caret', () => {
    const result = renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 2, true, 0, snapshot({ x: 0, y: 3 }));
    expect(result.cursor).toBeNull();
    expect(result.lines.join('\n')).not.toContain('l3');
  });
  test('non-passthrough renders and carets beyond the preview width have no caret', () => {
    expect(
      renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 20, false, 0, snapshot({ x: 0, y: 2 })).cursor,
    ).toBeNull();
    expect(
      renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 20, true, 0, snapshot({ x: 80, y: 7 })).cursor,
    ).toBeNull();
  });
  // Claude Code draws its slash-command menu below the prompt. In a pane taller
  // than the preview, the menu and the blank rows under it used to hide the prompt.
  test('shows a Claude prompt above its slash-command menu in a tall, mostly blank pane', () => {
    const menu = Array.from({ length: 33 }, (_, i) => `  /skill-${i}   description`);
    const rows = [' Claude Code', '', '─'.repeat(40), '❯ /s', '─'.repeat(40), ...menu, ...Array<string>(30).fill('')];
    const shot = { ...snapshot({ x: 4, y: 3 }), screen: rows.join('\n') + '\n' };
    const result = renderPreviewWithCursor(makeState(AgentStatus.IDLE), 120, 51, true, 0, shot);
    expect(result.cursor).toEqual({ row: 5, col: 4 });
    expect(result.lines[5]).toBe('❯ /s');
    expect(result.lines[7]).toBe('  /skill-0   description');
  });
  test('keeps a quarter of the view above a caret whose menu overflows the preview', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => `t${i}`),
      '❯ /s',
      ...Array.from({ length: 37 }, (_, i) => `m${i}`),
    ];
    const shot = { ...snapshot({ x: 4, y: 30 }), screen: rows.join('\n') + '\n' };
    const result = renderPreviewWithCursor(makeState(AgentStatus.IDLE), 80, 22, true, 0, shot);
    expect(result.cursor).toEqual({ row: 7, col: 4 });
    expect(result.lines.slice(2, 8)).toEqual(['t25', 't26', 't27', 't28', 't29', '❯ /s']);
    expect(result.lines[21]).toBe('m13');
  });
  test('never shows another pane’s late snapshot', () => {
    const result = renderPreviewWithCursor(
      makeState(AgentStatus.IDLE),
      80,
      20,
      true,
      0,
      snapshot({ x: 0, y: 2 }, '%2'),
    );
    expect(result.lines.join('\n')).not.toContain('l0');
    expect(result.cursor).toBeNull();
  });
  test('an ANSI snapshot survives repeated renders unchanged', () => {
    const shot = { ...snapshot(null), screen: '\x1b[31mhello\x1b[0m\n' };
    for (let i = 0; i < 20; i++) {
      expect(renderPreviewWithCursor(makeState(AgentStatus.IDLE), 80, 20, false, i, shot).lines.join('\n')).toContain(
        shot.screen.trim(),
      );
    }
  });
});

describe('async preview observation', () => {
  test('uses control mode for both ANSI capture and cursor without forks', async () => {
    const calls: string[] = [];
    const shot = await readPreview('%1', {
      capturePane: async (id, ansi) => {
        calls.push(`${id} ${ansi}`);
        return 'screen\n';
      },
      run: async (command) => {
        calls.push(command);
        return '3,2';
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('%1 true');
    expect(shot.screen).toBe('screen\n');
    expect(shot.cursor).toEqual({ x: 3, y: 2 });
  });
});
