// Sibling-worktree grouping. Panes whose git metadata shares a repository id
// (the absolute git common dir) are worktrees of the same repository. This pure
// module derives that grouping — and the per-group metadata (sibling count,
// distinct worktree roots) — from an already-resolved AgentState[], so it never
// spawns git or touches disk. The TUI opts into a repo-group view built on top
// of it; default ordering/navigation never calls this.

import { basename, dirname } from 'node:path';
import type { AgentState } from './types.ts';

export interface RepoGroup {
  repoId: string; // absolute git common dir — the grouping key
  worktreeCount: number; // distinct worktree roots in this group
  memberPanes: string[]; // pane ids in this group, input order preserved
}

// Group panes by repository id. Panes without git metadata are skipped (they
// belong to no repo). worktreeCount counts DISTINCT worktree roots, so two
// panes cd'd into the same worktree count as one worktree but two members.
export function computeRepoGroups(states: readonly AgentState[]): Map<string, RepoGroup> {
  const groups = new Map<string, RepoGroup>();
  const worktreesByRepo = new Map<string, Set<string>>();
  for (const s of states) {
    const git = s.git;
    if (!git) continue;
    let group = groups.get(git.repoId);
    if (!group) {
      group = { repoId: git.repoId, worktreeCount: 0, memberPanes: [] };
      groups.set(git.repoId, group);
      worktreesByRepo.set(git.repoId, new Set());
    }
    group.memberPanes.push(s.paneId);
    worktreesByRepo.get(git.repoId)!.add(git.worktreeRoot);
  }
  for (const [repoId, group] of groups) {
    group.worktreeCount = worktreesByRepo.get(repoId)!.size;
  }
  return groups;
}

// A short, human repo label from a repository id (an absolute git common dir).
// `/x/repo/.git` -> `repo`; a bare `/x/repo.git` -> `repo`. Falls back to the
// raw basename when neither shape fits.
export function repoLabelFromId(repoId: string): string {
  const base = basename(repoId);
  if (base === '.git') return basename(dirname(repoId));
  if (base.endsWith('.git')) return base.slice(0, -'.git'.length);
  return base;
}

// The number of OTHER worktrees for a given pane's repo (self excluded), or 0
// when the pane has no git metadata / no siblings. Used by the JSON view.
export function siblingWorktreeCount(state: AgentState, groups: Map<string, RepoGroup>): number {
  if (!state.git) return 0;
  return Math.max(0, (groups.get(state.git.repoId)?.worktreeCount ?? 1) - 1);
}
