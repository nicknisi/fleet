import { describe, expect, test } from 'bun:test';
import { TuiApp } from './app.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import type { GitMetadata } from '../state/git-metadata.ts';

function meta(repoId: string, worktreeRoot: string, branch = 'main'): GitMetadata {
  return {
    repoId,
    commonDir: repoId,
    worktreeRoot,
    branch,
    detached: false,
    head: 'abc',
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    upstream: null,
    diffstat: { files: 0, added: 0, removed: 0 },
  };
}

function agent(paneId: string, session: string, status: AgentStatus, git: GitMetadata | null): AgentState {
  return {
    paneId,
    paneNum: parseInt(paneId.replace('%', ''), 10),
    session,
    window: session,
    windowId: `@${paneId.replace('%', '')}`,
    claudeName: null,
    customName: null,
    status,
    tool: null,
    project: `~/p/${session}`,
    branch: git?.branch ?? null,
    git,
    ports: [],
    ts: 0,
    agentType: 'claude',
  };
}

describe('repo-group mode', () => {
  // Two worktrees of the same repo live in two different tmux sessions.
  const states = [
    agent('%1', 'api-main', AgentStatus.IDLE, meta('/r/api/.git', '/r/api')),
    agent('%2', 'api-feat', AgentStatus.BUSY, meta('/r/api/.git', '/r/api-feat')),
    agent('%3', 'web', AgentStatus.IDLE, meta('/r/web/.git', '/r/web')),
  ];

  test('off by default — grouped by session, one row each', () => {
    const app = new TuiApp();
    app.updateStates(states);
    expect(app.repoGroupMode).toBe(false);
    const rows = app.dashboardRows();
    // Three distinct sessions => three singleton agent rows, no headers.
    expect(rows.filter((r) => r.kind === 'header')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'agent')).toHaveLength(3);
  });

  test('toggling groups sibling worktrees under a repo header', () => {
    const app = new TuiApp();
    app.updateStates(states);
    app.toggleRepoGroupMode();
    expect(app.repoGroupMode).toBe(true);
    const rows = app.dashboardRows();
    const headers = rows.filter((r) => r.kind === 'header');
    // The two api worktrees group under one 'api' repo header; web is a singleton.
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ label: 'api', count: 2 });
  });

  test('membership is unchanged by the toggle — same visible panes', () => {
    const app = new TuiApp();
    app.updateStates(states);
    const before = new Set(app.visibleStates().map((s) => s.paneId));
    app.toggleRepoGroupMode();
    const after = new Set(app.visibleStates().map((s) => s.paneId));
    expect(after).toEqual(before);
  });

  test('selection is stable across a toggle (same agent stays selected)', () => {
    const app = new TuiApp();
    app.updateStates(states);
    // Select the second visible agent, whichever pane that is.
    app.selectedIndex = 1;
    const selected = app.selectedState()!.paneId;
    app.toggleRepoGroupMode();
    expect(app.selectedState()!.paneId).toBe(selected);
    app.toggleRepoGroupMode();
    expect(app.selectedState()!.paneId).toBe(selected);
  });

  test('panes without git metadata still render (fall back to session grouping)', () => {
    const app = new TuiApp();
    app.updateStates([...states, agent('%4', 'shellish', AgentStatus.IDLE, null)]);
    app.toggleRepoGroupMode();
    const panes = app.visibleStates().map((s) => s.paneId);
    expect(panes).toContain('%4');
  });
});
