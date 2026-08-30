import { describe, expect, test, beforeAll, mock } from 'bun:test';
import { previewActions } from './preview.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import type { AlignedCapture } from '../tmux/sessions.ts';
import { disableColors } from '../terminal/colors.ts';

disableColors();

// tmux reads real panes; mock them so preview rendering is deterministic. The
// aligned capture + cursor drive the passthrough caret; tests mutate these.
let alignedCap: AlignedCapture = { lines: ['l0', 'l1', 'l2'], droppedTop: 0 };
let paneCursorValue: { x: number; y: number } | null = { x: 0, y: 0 };
mock.module('../tmux/sessions.ts', () => ({
  capturePane: () => ['pane content'],
  capturePaneAligned: () => alignedCap,
  paneCursor: () => paneCursorValue,
}));

let renderPreview: typeof import('./preview.ts').renderPreview;
let renderPreviewWithCursor: typeof import('./preview.ts').renderPreviewWithCursor;
let captureForPreview: typeof import('./preview.ts').captureForPreview;
let invalidatePreviewCache: typeof import('./preview.ts').invalidatePreviewCache;

beforeAll(async () => {
  ({ renderPreview, renderPreviewWithCursor, captureForPreview, invalidatePreviewCache } = await import(
    './preview.ts'
  ));
});

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

describe('previewActions', () => {
  test('PERMIT shows approve/deny', () => {
    const actions = previewActions(makeState(AgentStatus.PERMIT));
    expect(actions).toContain('approve');
    expect(actions).toContain('deny');
  });

  test('QUESTION shows answer inline', () => {
    const actions = previewActions(makeState(AgentStatus.QUESTION));
    expect(actions).toContain('answer inline');
  });

  test('DONE shows passthrough and send', () => {
    const actions = previewActions(makeState(AgentStatus.DONE));
    expect(actions).toContain('passthrough');
    expect(actions).toContain('send prompt');
  });

  test('BUSY shows passthrough', () => {
    const actions = previewActions(makeState(AgentStatus.BUSY));
    expect(actions).toContain('passthrough');
  });

  test('SHELL returns empty', () => {
    const actions = previewActions(makeState(AgentStatus.SHELL));
    expect(actions).toBe('');
  });
});

describe('renderPreview title', () => {
  test('labels window-first with the session as context', () => {
    const lines = renderPreview({ ...makeState(AgentStatus.DONE), window: 'editor' }, 80, 20);
    expect(lines[0]).toContain('editor [test] · READY');
  });

  test('collapses to the bare session when the window adds nothing', () => {
    const lines = renderPreview({ ...makeState(AgentStatus.DONE), window: 'test' }, 80, 20);
    expect(lines[0]).toContain('test · READY');
    expect(lines[0]).not.toContain('[');
  });
});

describe('renderPreviewWithCursor passthrough caret', () => {
  test('maps cursor_y through droppedTop onto a preview row (after title+separator)', () => {
    alignedCap = { lines: ['l0', 'l1', 'l2', 'l3'], droppedTop: 5 };
    paneCursorValue = { x: 7, y: 6 }; // 6 - 5 = content row 1
    invalidatePreviewCache('%1');
    const { cursor } = renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 20, true);
    // row = CONTENT_ROW_OFFSET(2) + contentRow(1); col = cursor_x
    expect(cursor).toEqual({ row: 3, col: 7 });
  });

  test('returns no caret when the pane cursor is above the shown window', () => {
    alignedCap = { lines: ['l0', 'l1'], droppedTop: 5 };
    paneCursorValue = { x: 0, y: 2 }; // 2 - 5 < 0 → off-screen
    invalidatePreviewCache('%1');
    const { cursor } = renderPreviewWithCursor(makeState(AgentStatus.BUSY), 80, 20, true);
    expect(cursor).toBeNull();
  });

  test('non-passthrough preview never carries a caret', () => {
    const { cursor } = renderPreviewWithCursor(makeState(AgentStatus.DONE), 80, 20, false);
    expect(cursor).toBeNull();
  });
});

describe('captureForPreview', () => {
  const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

  test('reuses the capture within the TTL', () => {
    let calls = 0;
    const fetch = () => {
      calls++;
      return ['x'];
    };
    captureForPreview('%t1', 10, 1000, fetch);
    captureForPreview('%t1', 10, 1200, fetch);
    expect(calls).toBe(1);
  });

  test('refetches after the TTL or for a larger window', () => {
    let calls = 0;
    const fetch = (_id: string, n: number) => {
      calls++;
      return linesOf(n);
    };
    captureForPreview('%t2', 10, 1000, fetch);
    captureForPreview('%t2', 10, 1500, fetch); // TTL expired
    captureForPreview('%t2', 20, 1600, fetch); // larger than the cached window
    expect(calls).toBe(3);
  });

  test('serves a smaller window as the tail of the cached capture', () => {
    const fetch = (_id: string, n: number) => linesOf(n);
    captureForPreview('%t3', 10, 1000, fetch);
    expect(captureForPreview('%t3', 3, 1100, fetch)).toEqual(['l7', 'l8', 'l9']);
  });
});
