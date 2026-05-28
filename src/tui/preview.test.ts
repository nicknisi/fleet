import { describe, expect, test } from 'bun:test';
import { previewActions } from './preview.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { disableColors } from '../terminal/colors.ts';

disableColors();

const makeState = (status: AgentStatus): AgentState => ({
  paneId: '%1',
  paneNum: 1,
  session: 'test',
  claudeName: null,
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
