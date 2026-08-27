import { describe, expect, test } from 'bun:test';
import {
  AgentStatus,
  statusPriority,
  compareStatus,
  extractClaudeName,
  extractPiTitleName,
  agentSessionName,
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

  test('attention states (PERMIT, QUESTION, DONE) all sort above BUSY', () => {
    // The three states that need you — blocked, asking, or finished — lead the
    // order. DONE outranks BUSY so a finished agent waiting on you is surfaced
    // ahead of quiet background work; BUSY still outranks idle.
    expect(statusPriority(AgentStatus.QUESTION)).toBeLessThan(statusPriority(AgentStatus.DONE));
    expect(statusPriority(AgentStatus.DONE)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.BUSY)).toBeLessThan(statusPriority(AgentStatus.IDLE));
  });

  test('the full priority order is PERMIT, QUESTION, DONE, BUSY, IDLE, SHELL, DOWN', () => {
    const order = [
      AgentStatus.PERMIT,
      AgentStatus.QUESTION,
      AgentStatus.DONE,
      AgentStatus.BUSY,
      AgentStatus.IDLE,
      AgentStatus.SHELL,
      AgentStatus.DOWN,
    ];
    // Each entry is strictly less urgent than the next — locks the exact order.
    for (let i = 0; i < order.length - 1; i++) {
      expect(statusPriority(order[i]!)).toBeLessThan(statusPriority(order[i + 1]!));
    }
    // Shuffling and re-sorting recovers the canonical order.
    const shuffled = [...order].reverse();
    shuffled.sort(compareStatus);
    expect(shuffled).toEqual(order);
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
    expect(statuses).toEqual([AgentStatus.PERMIT, AgentStatus.DONE, AgentStatus.BUSY, AgentStatus.IDLE]);
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

  describe('extractPiTitleName', () => {
    // Caller gates to identified pi panes; these shapes come from pi core
    // (`π - name - dir`, unnamed `π - dir`) and the session-name package
    // (unnamed `π — dir`, named titleFormat like `{summary}` or `{summary} — {dir}`).
    test("reads the name from pi's built-in title format", () => {
      expect(extractPiTitleName('π - Diagnose GitHub issue #73 - arc', '/Users/n/dev/arc')).toBe(
        'Diagnose GitHub issue #73',
      );
    });

    test('unnamed titles yield null in both dash styles', () => {
      expect(extractPiTitleName('π - arc', '/Users/n/dev/arc')).toBeNull();
      expect(extractPiTitleName('π — arc', '/Users/n/dev/arc')).toBeNull();
      expect(extractPiTitleName('π', '/Users/n/dev/arc')).toBeNull();
    });

    test('splits on the cwd basename so names containing the separator survive', () => {
      expect(extractPiTitleName('π - Fix - arc - arc', '/x/arc')).toBe('Fix - arc');
    });

    test('a name equal to the dir still parses', () => {
      expect(extractPiTitleName('π - arc - arc', '/x/arc')).toBe('arc');
    });

    test("bare {summary} titles are trusted whole (pi-pane gating is the caller's job)", () => {
      expect(extractPiTitleName('Thermo-nuclear code quality review', '/x/riker')).toBe(
        'Thermo-nuclear code quality review',
      );
      // Non-pi-looking titles too — the caller only invokes this for pi panes.
      expect(extractPiTitleName('✳ Fix auth bug', '/x/arc')).toBe('✳ Fix auth bug');
    });

    test('the {summary} — {dir} package format strips the dir suffix', () => {
      expect(extractPiTitleName('Fix auth — arc', '/x/arc')).toBe('Fix auth');
    });

    test('a leading braille spinner frame is stripped', () => {
      expect(extractPiTitleName('⠋ π - Fix auth - arc', '/x/arc')).toBe('Fix auth');
    });
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

  test('window renamed after fleet’s sidebar icon falls back to the project basename', () => {
    expect(windowLabel({ ...base, window: '☰ nicknisi', project: '~/Developer/sessions' })).toBe('sessions');
    expect(windowLabel({ ...base, window: '☰ nicknisi', project: null })).toBe('dotfiles');
  });

  test('fleet-titled window in the fleet repo still reads fleet', () => {
    expect(windowLabel({ ...base, window: 'fleet', project: '~/Developer/fleet' })).toBe('fleet');
  });

  test('a window merely containing fleet is untouched', () => {
    expect(windowLabel({ ...base, window: '󱙺 fleet', project: '~/Developer/sessions' })).toBe('󱙺 fleet');
  });
});

describe('agentSessionName', () => {
  test('prefers the hook-provided agent name over the pane-title name', () => {
    expect(agentSessionName({ ...base, agentName: 'Refactor auth module', claudeName: 'Fix auth bug' })).toBe(
      'Refactor auth module',
    );
  });

  test('falls back to claudeName, then null', () => {
    expect(agentSessionName({ ...base, claudeName: 'Fix auth bug' })).toBe('Fix auth bug');
    expect(agentSessionName(base)).toBeNull();
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

  test('agentName wins over claudeName and session, loses to customName', () => {
    expect(displayName({ ...base, agentName: 'Refactor auth module', claudeName: 'Fix auth bug' })).toBe(
      'Refactor auth module',
    );
    expect(displayName({ ...base, customName: 'prod hotfix', agentName: 'Refactor auth module' })).toBe('prod hotfix');
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
