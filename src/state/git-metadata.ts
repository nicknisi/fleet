// Read-only git metadata per pane cwd. Replaces the old branch-only slow cache
// with a richer, still read-only snapshot: repository identity (the absolute
// git common dir, shared by every worktree of a repo), the worktree root, the
// branch/detached head, the working-tree dirtiness (staged/unstaged/untracked
// counts), ahead/behind vs upstream, and a diffstat (files/added/removed).
//
// Invariants:
//   - Bounded, direct `git` argv spawns (no shell, fixed arg lists).
//   - Pure parsers (parseRevParse / parseStatusV2 / parseNumstat) take raw
//     command output + cwd and never touch the filesystem or spawn anything.
//   - null on any non-git dir or failure — never throws.
//   - Slow tick only. Zero fast-tick subprocesses (the cache is read on the
//     fast path, refreshed on the slow path — same lifecycle as portCache).

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GitDiffstat {
  files: number;
  added: number;
  removed: number;
}

export interface GitMetadata {
  // Absolute git common dir — the identity shared by every linked worktree of a
  // repo (linked worktrees all resolve --git-common-dir to the main repo's
  // .git). Doubles as the repository id / sibling-grouping key.
  repoId: string;
  commonDir: string;
  // Absolute worktree root (--show-toplevel). Distinct per worktree.
  worktreeRoot: string;
  branch: string | null; // null when detached
  detached: boolean;
  head: string | null; // HEAD oid (full), null on an unborn branch
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  diffstat: GitDiffstat;
}

// --- Pure parsers ---------------------------------------------------------

export interface RevParse {
  commonDir: string; // absolute
  worktreeRoot: string; // absolute
}

// `git rev-parse --git-common-dir --show-toplevel` emits two lines. The common
// dir may be relative to cwd (e.g. `.git`), so resolve it against cwd to get a
// stable absolute identity. null when either line is missing (not a work tree).
export function parseRevParse(stdout: string, cwd: string): RevParse | null {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const commonDirRaw = lines[0]!;
  const worktreeRoot = lines[1]!;
  if (commonDirRaw.length === 0 || worktreeRoot.length === 0) return null;
  return {
    commonDir: resolve(cwd, commonDirRaw),
    worktreeRoot,
  };
}

export interface StatusV2 {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  dirty: boolean;
}

// Parse `git status --porcelain=v2 --branch` (newline form). Branch headers
// carry oid/head/upstream/ab; entry lines carry the per-file staged (X) and
// unstaged (Y) status in their XY field. Counts drive dirtiness so the caller
// never has to re-scan.
export function parseStatusV2(stdout: string): StatusV2 {
  let branch: string | null = null;
  let detached = false;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let unmerged = 0;

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('# branch.')) {
      const rest = line.slice('# branch.'.length);
      const sp = rest.indexOf(' ');
      const key = sp === -1 ? rest : rest.slice(0, sp);
      const value = sp === -1 ? '' : rest.slice(sp + 1);
      switch (key) {
        case 'oid':
          head = value === '(initial)' ? null : value;
          break;
        case 'head':
          if (value === '(detached)') {
            detached = true;
            branch = null;
          } else {
            branch = value;
          }
          break;
        case 'upstream':
          upstream = value.length > 0 ? value : null;
          break;
        case 'ab': {
          // "+<ahead> -<behind>"
          const m = value.match(/\+(-?\d+)\s+-(-?\d+)/);
          if (m) {
            ahead = parseInt(m[1]!, 10) || 0;
            behind = parseInt(m[2]!, 10) || 0;
          }
          break;
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      // "1 XY ..." / "2 XY ..." — field 1 (0-indexed) is the XY status.
      const xy = line.split(' ')[1] ?? '..';
      const x = xy[0];
      const y = xy[1];
      if (x && x !== '.') staged++;
      if (y && y !== '.') unstaged++;
    } else if (kind === 'u') {
      unmerged++;
    } else if (kind === '?') {
      untracked++;
    }
    // '!' (ignored) is not counted — status --porcelain omits it by default.
  }

  const dirty = staged > 0 || unstaged > 0 || untracked > 0 || unmerged > 0;
  return { branch, detached, head, upstream, ahead, behind, staged, unstaged, untracked, dirty };
}

// Parse `git diff --numstat` output: "<added>\t<removed>\t<path>" per file.
// Binary files show "-\t-\t<path>" and contribute a file but zero line counts.
export function parseNumstat(stdout: string): GitDiffstat {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files++;
    const a = parseInt(parts[0]!, 10);
    const r = parseInt(parts[1]!, 10);
    if (!Number.isNaN(a)) added += a;
    if (!Number.isNaN(r)) removed += r;
  }
  return { files, added, removed };
}

// --- Bounded git spawns ---------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(cwd: string, args: string[]): GitResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
      stdout: 'pipe',
      stderr: 'ignore',
      // Observation must not refresh/write the user's index or contend on
      // index.lock with an interactive git command.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (proc.exitCode !== 0) return { ok: false, stdout: '' };
    return { ok: true, stdout: proc.stdout.toString() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// Read the full metadata for a single cwd. Three bounded git spawns:
//   rev-parse (identity + worktree root), status v2 (branch/dirty/ahead-behind),
//   diff --numstat (diffstat). null on non-git/failure of the identity probe.
export function readGitMetadata(cwd: string): GitMetadata | null {
  const rp = git(cwd, ['rev-parse', '--git-common-dir', '--show-toplevel']);
  if (!rp.ok) return null;
  const identity = parseRevParse(rp.stdout, cwd);
  if (!identity) return null;

  const st = git(cwd, ['status', '--porcelain=v2', '--branch']);
  const status = st.ok
    ? parseStatusV2(st.stdout)
    : {
        branch: null,
        detached: false,
        head: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        dirty: false,
      };

  // Diff vs HEAD captures staged + unstaged changes. Fails (and stays zero) on
  // an unborn branch with no commits — the rest of the metadata is still valid.
  const nd = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD']);
  const diffstat = nd.ok ? parseNumstat(nd.stdout) : { files: 0, added: 0, removed: 0 };

  let commonDir = identity.commonDir;
  try {
    commonDir = realpathSync(commonDir);
  } catch {
    // Keep the lexical absolute path when canonicalization is unavailable.
  }

  return {
    repoId: commonDir,
    commonDir,
    worktreeRoot: identity.worktreeRoot,
    branch: status.branch,
    detached: status.detached,
    head: status.head,
    dirty: status.dirty,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    ahead: status.ahead,
    behind: status.behind,
    upstream: status.upstream,
    diffstat,
  };
}

// The branch label the legacy `state.branch` field carried: the branch name, or
// 'HEAD' when detached (matching `git rev-parse --abbrev-ref HEAD`), or null.
export function branchLabel(meta: GitMetadata | null): string | null {
  if (!meta) return null;
  if (meta.detached) return 'HEAD';
  return meta.branch;
}
