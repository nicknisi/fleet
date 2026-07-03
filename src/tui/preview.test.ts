import { describe, expect, test, beforeAll, mock } from 'bun:test';
import { previewActions } from './preview.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { disableColors } from '../terminal/colors.ts';

disableColors();

// capturePane reads real tmux; mock it so renderPreview is deterministic.
mock.module('../tmux/sessions.ts', () => ({
  capturePane: () => ['pane content'],
}));

let renderPreview: typeof import('./preview.ts').renderPreview;

beforeAll(async () => {
  ({ renderPreview } = await import('./preview.ts'));
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
