import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
let work: string;
let log: string;
let home: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'fleet-status-refresh-'));
  log = join(work, 'calls');
  home = join(work, 'home');
  mkdirSync(join(home, '.cache', 'claude-status'), { recursive: true });
  mkdirSync(join(work, 'repo', '.git'), { recursive: true });
  mkdirSync(join(work, 'bin'));
  writeFileSync(log, '');
  writeFileSync(
    join(work, 'bin', 'tmux'),
    `#!/bin/sh
printf 'tmux %s\\n' "$*" >> "$FLEET_TEST_LOG"
case "$1" in
  list-panes) printf '%s\\n' "$FLEET_TEST_PANES" ;;
  show) case "$*" in *@fleet_rollup*) printf '1\\n' ;; esac ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(work, 'bin', 'git'),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FLEET_TEST_LOG"
case "$*" in
  *rev-parse*) printf '.git\\n%s\\n' "$FLEET_TEST_REPO" ;;
  *status*) printf '# branch.oid abcdef\\n# branch.head main\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  for (const command of ['ps', 'lsof']) {
    writeFileSync(join(work, 'bin', command), `#!/bin/sh\nprintf '${command}\\n' >> "$FLEET_TEST_LOG"\n`, {
      mode: 0o755,
    });
  }
  setState('permit');
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

function setState(state: string): void {
  writeFileSync(
    join(home, '.cache', 'claude-status', '1.status'),
    JSON.stringify({ state, pane: '%1', session: 'test', ts: Math.floor(Date.now() / 1000), tmux_pid: 1 }),
  );
}

function run(...args: string[]): string {
  const repo = join(work, 'repo');
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(root, 'index.ts'), ...args],
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      TMPDIR: work,
      TMUX: '/tmp/status-refresh.sock,1,0',
      PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      FLEET_TEST_LOG: log,
      FLEET_TEST_REPO: repo,
      FLEET_TEST_PANES: `%1\ttest\trepo\t@1\t0\t${repo}\t123\t1\t1\t1\ttest title`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function calls(): string[] {
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

describe('statusline refresh work', () => {
  test('cold chips retain attention discovery without git or listener scans', () => {
    const output = run('status', '--statusline');
    expect(output).toContain('#[range=user|%1]');
    expect(output).toContain('\u26a0');
    expect(calls().filter((line) => line.startsWith('git '))).toHaveLength(0);
    expect(calls().filter((line) => line === 'lsof')).toHaveLength(0);
    expect(calls().filter((line) => line === 'ps')).toHaveLength(1);
    expect(calls().filter((line) => line.startsWith('tmux capture-pane '))).toHaveLength(1);

    writeFileSync(log, '');
    expect(run('status', '--statusline')).toBe(output);
    expect(calls()).toEqual([]);
  });

  test('regular JSON status still gathers repository and port details', () => {
    run('status', '--json');
    expect(calls().filter((line) => line.startsWith('git '))).toHaveLength(3);
    expect(calls().filter((line) => line === 'lsof')).toHaveLength(1);
  });

  test('a cold refresh clears the window tint when attention ends', () => {
    run('status', '--statusline');
    expect(calls().some((line) => line.includes('set -w -t @1 @fleet_state yellow'))).toBe(true);
    for (const name of readdirSync(work)) {
      if (name.endsWith('.cache')) rmSync(join(work, name));
    }
    setState('idle');
    writeFileSync(log, '');
    expect(run('status', '--statusline')).not.toContain('#[range=user|%1]');
    expect(calls().some((line) => line.includes('set -w -u -t @1 @fleet_state'))).toBe(true);
  });
});
