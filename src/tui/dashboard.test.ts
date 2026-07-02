import { describe, expect, test } from 'bun:test';
import { disableColors } from '../terminal/colors.ts';

disableColors();

import { computeColumnWidths, renderSessionList, stateAtLine } from './dashboard.ts';
import { TuiApp } from './app.ts';
import { stripAnsi, visibleLength } from '../terminal/ansi.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (
  session: string,
  status: AgentStatus,
  paneId: string,
  window: string,
  extra: Partial<AgentState> = {},
): AgentState => ({
  paneId,
  paneNum: 1,
  session,
  window,
  claudeName: null,
  status,
  tool: null,
  project: `~/Developer/${session}`,
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...extra,
});

function makeApp(states: AgentState[]): TuiApp {
  const app = new TuiApp();
  app.updateStates(states);
  return app;
}

describe('renderSessionList grouping', () => {
  test('session with 2+ agents renders a header line plus indented rows', () => {
    const app = makeApp([
      makeState('cli', AgentStatus.PERMIT, '%1', 'alpha'),
      makeState('cli', AgentStatus.IDLE, '%2', 'beta'),
    ]);
    const lines = renderSessionList(app, 20, 120).map(stripAnsi);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('cli');
    expect(lines[0]).toContain('· 2 agents');
    expect(lines[1]).toContain('  alpha');
    expect(lines[2]).toContain('  beta');
  });

  test('single-agent session renders one inline session · window row, no header', () => {
    const app = makeApp([makeState('solo', AgentStatus.IDLE, '%1', 'editor')]);
    const lines = renderSessionList(app, 20, 120).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('solo · editor');
    expect(lines[0]).not.toContain('agents');
  });

  test('singleton whose window matches the session collapses to bare session', () => {
    const app = makeApp([makeState('skills', AgentStatus.IDLE, '%1', 'skills')]);
    const lines = renderSessionList(app, 20, 120).map(stripAnsi);
    expect(lines[0]).toContain('skills');
    expect(lines[0]).not.toContain('·');
  });

  test('empty state renders the all-quiet default, not the old No agents found', () => {
    const app = makeApp([]);
    const lines = renderSessionList(app, 20, 120).map(stripAnsi).join('\n');
    expect(lines).toContain('all quiet');
    expect(lines).not.toContain('No agents found');
  });
});

describe('column widths and shrink order', () => {
  const LONG_WINDOW = 'window-name-20-chars'; // 20 chars

  test('20-char window name renders untruncated at 120 and 80 cols', () => {
    for (const cols of [120, 80]) {
      const app = makeApp([
        makeState('cli', AgentStatus.PERMIT, '%1', LONG_WINDOW),
        makeState('cli', AgentStatus.IDLE, '%2', 'beta'),
      ]);
      const lines = renderSessionList(app, 20, cols).map(stripAnsi);
      expect(lines[1]).toContain(LONG_WINDOW);
      expect(lines[1]).not.toContain('…');
    }
  });

  test('branch column drops before the window name loses a character', () => {
    const app = makeApp([
      makeState('cli', AgentStatus.PERMIT, '%1', LONG_WINDOW, { branch: 'feature-branch' }),
      makeState('cli', AgentStatus.IDLE, '%2', 'beta', { branch: 'feature-branch' }),
    ]);
    // name = 22 (indent+20); detail at 12-col branch would be 50-11-22-12 = 5 < 8
    const lines = renderSessionList(app, 20, 50).map(stripAnsi);
    expect(lines[1]).toContain(LONG_WINDOW);
    expect(lines[1]).not.toContain('feature-bran');
  });

  test('window truncates only as a last resort on very narrow terminals', () => {
    const widths = computeColumnWidths(
      makeApp([
        makeState('cli', AgentStatus.PERMIT, '%1', LONG_WINDOW),
        makeState('cli', AgentStatus.IDLE, '%2', 'beta'),
      ]).dashboardRows(),
      35,
    );
    expect(widths.branch).toBe(0);
    expect(widths.detail).toBe(8);
    expect(widths.name).toBeLessThan(22);
  });

  test('emoji and ASCII window names align: detail starts at the same visible column', () => {
    const app = makeApp([
      makeState('cli', AgentStatus.PERMIT, '%1', '🤖 workos', { claudeName: 'TaskOne' }),
      makeState('cli', AgentStatus.PERMIT, '%2', 'plain', { claudeName: 'TaskTwo' }),
    ]);
    const lines = renderSessionList(app, 20, 120).map(stripAnsi);
    const pre1 = lines[1]!.slice(0, lines[1]!.indexOf('TaskOne'));
    const pre2 = lines[2]!.slice(0, lines[2]!.indexOf('TaskTwo'));
    expect(visibleLength(pre1)).toBe(visibleLength(pre2));
  });
});

describe('scroll in row space', () => {
  test('selected row stays within the returned window', () => {
    const states: AgentState[] = [];
    for (let i = 0; i < 12; i++) {
      states.push(makeState(`s${String(i).padStart(2, '0')}`, AgentStatus.IDLE, `%a${i}`, 'one'));
      states.push(makeState(`s${String(i).padStart(2, '0')}`, AgentStatus.IDLE, `%b${i}`, 'two'));
    }
    const app = makeApp(states); // 12 groups × 3 rows = 36 rows
    for (let i = 0; i < 20; i++) app.moveDown(); // select deep in the list
    const lines = renderSessionList(app, 10, 120);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.some((l) => stripAnsi(l).startsWith('▌'))).toBe(true);
  });

  test('selected last row of a large group stays visible while its header scrolls off', () => {
    const states: AgentState[] = [];
    for (let i = 0; i < 15; i++) {
      states.push(makeState('big', AgentStatus.IDLE, `%${i}`, `w${String(i).padStart(2, '0')}`));
    }
    const app = makeApp(states); // rows: 1 header + 15 agents
    for (let i = 0; i < 14; i++) app.moveDown(); // select the last agent

    const lines = renderSessionList(app, 8, 120).map(stripAnsi);
    expect(lines).toHaveLength(8);
    // Selected row is visible at the bottom of the viewport…
    expect(lines[lines.length - 1]).toContain('w14');
    expect(lines.some((l) => l.startsWith('▌'))).toBe(true);
    // …while the group header has scrolled off (the accepted edge from the spec).
    expect(lines.some((l) => l.includes('agents'))).toBe(false);
  });
});

describe('stateAtLine click mapping', () => {
  test('maps agent lines to states and header lines to null', () => {
    const app = makeApp([
      makeState('cli', AgentStatus.PERMIT, '%1', 'alpha'),
      makeState('cli', AgentStatus.IDLE, '%2', 'beta'),
      makeState('solo', AgentStatus.IDLE, '%3', 'main'),
    ]);
    // rows: header(cli), agent(%1), agent(%2), agent(%3)
    expect(stateAtLine(app, 0, 20)).toBeNull();
    expect(stateAtLine(app, 1, 20)?.paneId).toBe('%1');
    expect(stateAtLine(app, 2, 20)?.paneId).toBe('%2');
    expect(stateAtLine(app, 3, 20)?.paneId).toBe('%3');
    expect(stateAtLine(app, 4, 20)).toBeNull();
  });

  test('accounts for scroll offset', () => {
    const states: AgentState[] = [];
    for (let i = 0; i < 12; i++) {
      states.push(makeState(`s${String(i).padStart(2, '0')}`, AgentStatus.IDLE, `%a${i}`, 'one'));
      states.push(makeState(`s${String(i).padStart(2, '0')}`, AgentStatus.IDLE, `%b${i}`, 'two'));
    }
    const app = makeApp(states);
    for (let i = 0; i < 20; i++) app.moveDown();
    const maxRows = 10;
    const lines = renderSessionList(app, maxRows, 120);
    // The first rendered line and stateAtLine(0) must describe the same row.
    const first = stateAtLine(app, 0, maxRows);
    const firstLine = stripAnsi(lines[0]!);
    if (first) {
      expect(firstLine).toContain(first.window);
    } else {
      expect(firstLine).toContain('agents'); // header line
    }
  });
});

describe('empty states', () => {
  test('tmux down explains itself instead of "No agents found"', () => {
    const app = new TuiApp();
    app.tmuxDown = true;
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain("tmux isn't running");
    expect(lines).not.toContain('No agents found');
  });

  test('missing hooks points at fleet install', () => {
    const app = new TuiApp();
    app.hooksMissing = true;
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('no agent hooks found');
    expect(lines).toContain('fleet install');
  });

  test('empty filter result names the filter', () => {
    const app = new TuiApp();
    app.setFilter('zzz');
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('no agents match');
  });

  test('genuinely idle fleet is all quiet', () => {
    const app = new TuiApp();
    const lines = renderSessionList(app, 10, 80).join('\n');
    expect(lines).toContain('all quiet');
  });
});
