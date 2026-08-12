import { describe, expect, test } from 'bun:test';
import { parseRevParse, parseStatusV2, parseNumstat, branchLabel, type GitMetadata } from './git-metadata.ts';

describe('parseRevParse', () => {
  test('resolves a relative common dir against cwd', () => {
    const rp = parseRevParse('.git\n/home/u/proj\n', '/home/u/proj');
    expect(rp).toEqual({ commonDir: '/home/u/proj/.git', worktreeRoot: '/home/u/proj' });
  });

  test('keeps an absolute common dir (linked worktree shares the main .git)', () => {
    const rp = parseRevParse('/home/u/proj/.git\n/home/u/proj-wt\n', '/home/u/proj-wt');
    expect(rp).toEqual({ commonDir: '/home/u/proj/.git', worktreeRoot: '/home/u/proj-wt' });
  });

  test('null when not a work tree (fewer than two lines)', () => {
    expect(parseRevParse('', '/x')).toBeNull();
    expect(parseRevParse('.git\n', '/x')).toBeNull();
  });
});

describe('parseStatusV2', () => {
  test('clean repo on a branch with upstream', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');
    const s = parseStatusV2(out);
    expect(s.branch).toBe('main');
    expect(s.detached).toBe(false);
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.dirty).toBe(false);
    expect(s.staged + s.unstaged + s.untracked).toBe(0);
    expect(s.head).toBe('abc123');
  });

  test('counts staged/unstaged/untracked and marks dirty', () => {
    const out = [
      '# branch.head feature',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aa bb staged-only.ts',
      '1 .M N... 100644 100644 100644 cc dd unstaged-only.ts',
      '1 MM N... 100644 100644 100644 ee ff both.ts',
      '? untracked.ts',
      '? another-untracked.ts',
    ].join('\n');
    const s = parseStatusV2(out);
    expect(s.branch).toBe('feature');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(3);
    expect(s.staged).toBe(2); // M. and MM
    expect(s.unstaged).toBe(2); // .M and MM
    expect(s.untracked).toBe(2);
    expect(s.dirty).toBe(true);
  });

  test('detached head', () => {
    const s = parseStatusV2('# branch.oid deadbeef\n# branch.head (detached)\n');
    expect(s.detached).toBe(true);
    expect(s.branch).toBeNull();
    expect(s.upstream).toBeNull();
  });

  test('unborn branch (no commits) reports null head', () => {
    const s = parseStatusV2('# branch.oid (initial)\n# branch.head main\n');
    expect(s.head).toBeNull();
    expect(s.branch).toBe('main');
  });

  test('unmerged entries mark the tree dirty', () => {
    const s = parseStatusV2('# branch.head main\nu UU N... 1 2 3 4 5 6 7 conflict.ts\n');
    expect(s.dirty).toBe(true);
  });
});

describe('parseNumstat', () => {
  test('sums added/removed and counts files', () => {
    const d = parseNumstat('3\t1\ta.ts\n10\t0\tb.ts\n0\t4\tc.ts\n');
    expect(d).toEqual({ files: 3, added: 13, removed: 5 });
  });

  test('binary files count as a file but add zero lines', () => {
    const d = parseNumstat('-\t-\timg.png\n2\t1\ta.ts\n');
    expect(d).toEqual({ files: 2, added: 2, removed: 1 });
  });

  test('empty output is an empty diffstat', () => {
    expect(parseNumstat('')).toEqual({ files: 0, added: 0, removed: 0 });
  });
});

describe('branchLabel', () => {
  const base: GitMetadata = {
    repoId: '/r/.git',
    commonDir: '/r/.git',
    worktreeRoot: '/r',
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

  test('branch name when on a branch', () => {
    expect(branchLabel(base)).toBe('main');
  });

  test("'HEAD' when detached (matches git rev-parse --abbrev-ref)", () => {
    expect(branchLabel({ ...base, branch: null, detached: true })).toBe('HEAD');
  });

  test('null metadata is null', () => {
    expect(branchLabel(null)).toBeNull();
  });
});
