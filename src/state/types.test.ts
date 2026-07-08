import { describe, expect, test } from 'bun:test';
import {
  AgentStatus,
  statusPriority,
  compareStatus,
  extractClaudeName,
  displayName,
  sessionDisplay,
  sessionLabel,
  windowLabel,
  type AgentState,
} from './types.ts';

describe('statusPriority', () => {
  test('PERMIT is highest priority', () => {
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.QUESTION));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.DONE));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
  });

  test('blocking states sort above BUSY, which sorts above ready/idle', () => {
    // PERMIT and QUESTION need you now, so they outrank working. Working outranks
    // ready (finished, waiting on you) so live work stays visible; ready outranks idle.
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.QUESTION)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.BUSY)).toBeLessThan(statusPriority(AgentStatus.DONE));
    expect(statusPriority(AgentStatus.DONE)).toBeLessThan(statusPriority(AgentStatus.IDLE));
  });

  test('DOWN is lowest priority', () => {
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.SHELL));
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.IDLE));
  });
});

describe('compareStatus', () => {
  test('sorts higher priority first', () => {
    const statuses = [AgentStatus.IDLE, AgentStatus.PERMIT, AgentStatus.BUSY, AgentStatus.DONE];
    statuses.sort(compareStatus);
    expect(statuses).toEqual([AgentStatus.PERMIT, AgentStatus.BUSY, AgentStatus.DONE, AgentStatus.IDLE]);
  });
});

describe('extractClaudeName', () => {
  test('extracts name from ✳ prefix', () => {
    expect(extractClaudeName('✳ Deploy example app')).toBe('Deploy example app');
  });

  test('returns null for non-Claude pane titles', () => {
    expect(extractClaudeName('glootie.local')).toBeNull();
    expect(extractClaudeName('mac')).toBeNull();
  });

  test('returns null for spinner prefixes', () => {
    expect(extractClaudeName('⠂ Review Slack thread')).toBeNull();
    expect(extractClaudeName('⠏ telemetry')).toBeNull();
  });

  test('returns null for empty name after ✳', () => {
    expect(extractClaudeName('✳ ')).toBeNull();
    expect(extractClaudeName('✳')).toBeNull();
  });

  test('trims whitespace', () => {
    expect(extractClaudeName('  ✳ Fix bug  ')).toBe('Fix bug');
  });
});

const base: AgentState = {
  paneId: '%1',
  paneNum: 1,
  session: 'dotfiles',
  window: 'editor',
  windowId: '@1',
  claudeName: null,
  customName: null,
  status: AgentStatus.IDLE,
  tool: null,
  project: null,
  branch: null,
  ports: [],
  ts: 0,
  agentType: 'claude',
};

describe('sessionLabel', () => {
  test('joins session and window tmux-style', () => {
    expect(sessionLabel(base)).toBe('dotfiles:editor');
  });

  test('omits window when it matches the session name', () => {
    expect(sessionLabel({ ...base, window: 'dotfiles' })).toBe('dotfiles');
  });

  test('omits window when empty', () => {
    expect(sessionLabel({ ...base, window: '' })).toBe('dotfiles');
  });

  test("masks fleet's advertised title with the project basename", () => {
    expect(sessionLabel({ ...base, window: 'fleet', project: '~/Developer/sessions' })).toBe('dotfiles:sessions');
  });
});

describe('windowLabel', () => {
  test('returns the window name', () => {
    expect(windowLabel(base)).toBe('editor');
  });

  test('falls back to session when window is empty', () => {
    expect(windowLabel({ ...base, window: '' })).toBe('dotfiles');
  });

  test('falls back to session when window matches the session name', () => {
    expect(windowLabel({ ...base, window: 'dotfiles' })).toBe('dotfiles');
  });

  // A window named exactly 'fleet' was named by a title-aware renamer reading
  // fleet's own OSC 2 pane title, not this agent — the label must not mask the
  // agent's real project.
  test("window named after fleet's advertised title falls back to the project basename", () => {
    expect(windowLabel({ ...base, window: 'fleet', project: '~/Developer/sessions' })).toBe('sessions');
  });

  test('fleet-titled window with no project falls back to the session', () => {
    expect(windowLabel({ ...base, window: 'fleet', project: null })).toBe('dotfiles');
  });

  test('fleet-titled window in the fleet repo still reads fleet', () => {
    expect(windowLabel({ ...base, window: 'fleet', project: '~/Developer/fleet' })).toBe('fleet');
  });

  test('a window merely containing fleet is untouched', () => {
    expect(windowLabel({ ...base, window: '󱙺 fleet', project: '~/Developer/sessions' })).toBe('󱙺 fleet');
  });
});

describe('displayName', () => {
  test('returns claudeName when set', () => {
    expect(displayName({ ...base, claudeName: 'Fix auth bug' })).toBe('Fix auth bug');
  });

  test('falls back to session:window when no claudeName', () => {
    expect(displayName(base)).toBe('dotfiles:editor');
  });

  test('customName wins over claudeName and session', () => {
    expect(displayName({ ...base, customName: 'prod hotfix', claudeName: 'Fix auth bug' })).toBe('prod hotfix');
  });

  test('claudeName is used when customName is null', () => {
    expect(displayName({ ...base, customName: null, claudeName: 'Fix auth bug' })).toBe('Fix auth bug');
  });
});

describe('sessionDisplay', () => {
  test('returns customName when set', () => {
    expect(sessionDisplay({ ...base, customName: 'prod hotfix' })).toBe('prod hotfix');
  });

  test('falls back to the raw session name when customName is null', () => {
    expect(sessionDisplay(base)).toBe('dotfiles');
  });
});
