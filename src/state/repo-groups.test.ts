import { describe, expect, test } from 'bun:test';
import { computeRepoGroups, siblingWorktreeCount, repoLabelFromId } from './repo-groups.ts';
import { AgentStatus, type AgentState } from './types.ts';
import type { GitMetadata } from './git-metadata.ts';

function meta(repoId: string, worktreeRoot: string): GitMetadata {
  return {
    repoId,
    commonDir: repoId,
    worktreeRoot,
    branch: 'main',
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

function state(paneId: string, git: GitMetadata | null): AgentState {
  return {
    paneId,
    paneNum: parseInt(paneId.replace('%', ''), 10),
    session: 's',
    window: 'w',
    windowId: '@1',
    claudeName: null,
    customName: null,
    status: AgentStatus.IDLE,
    tool: null,
    project: '~/p',
    branch: 'main',
    git,
    workmux: null,
    ports: [],
    ts: 0,
    agentType: 'claude',
  };
}

describe('computeRepoGroups', () => {
  test('groups sibling worktrees by shared repository id', () => {
    const states = [
      state('%1', meta('/r/.git', '/r')),
      state('%2', meta('/r/.git', '/r-wt-a')),
      state('%3', meta('/r/.git', '/r-wt-b')),
      state('%4', meta('/other/.git', '/other')),
    ];
    const groups = computeRepoGroups(states);
    expect(groups.size).toBe(2);
    const r = groups.get('/r/.git')!;
    expect(r.worktreeCount).toBe(3);
    expect(r.memberPanes).toEqual(['%1', '%2', '%3']);
    expect(groups.get('/other/.git')!.worktreeCount).toBe(1);
  });

  test('two panes in the same worktree count as one worktree, two members', () => {
    const states = [state('%1', meta('/r/.git', '/r')), state('%2', meta('/r/.git', '/r'))];
    const groups = computeRepoGroups(states);
    expect(groups.get('/r/.git')!.worktreeCount).toBe(1);
    expect(groups.get('/r/.git')!.memberPanes).toEqual(['%1', '%2']);
  });

  test('panes without git metadata are skipped', () => {
    const states = [state('%1', null), state('%2', meta('/r/.git', '/r'))];
    const groups = computeRepoGroups(states);
    expect(groups.size).toBe(1);
  });
});

describe('siblingWorktreeCount', () => {
  test('returns the group worktree count for a member', () => {
    const states = [state('%1', meta('/r/.git', '/r')), state('%2', meta('/r/.git', '/r-wt'))];
    const groups = computeRepoGroups(states);
    expect(siblingWorktreeCount(states[0]!, groups)).toBe(2);
  });

  test('0 for a pane with no git metadata', () => {
    const groups = computeRepoGroups([]);
    expect(siblingWorktreeCount(state('%1', null), groups)).toBe(0);
  });
});

describe('repoLabelFromId', () => {
  test('strips a trailing /.git', () => {
    expect(repoLabelFromId('/home/u/fleet/.git')).toBe('fleet');
  });

  test('strips a bare repo .git suffix', () => {
    expect(repoLabelFromId('/srv/git/fleet.git')).toBe('fleet');
  });

  test('falls back to the basename otherwise', () => {
    expect(repoLabelFromId('/home/u/fleet')).toBe('fleet');
  });
});
