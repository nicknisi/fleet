// Compiled-binary smoke suite (test:smoke). Runs the ACTUAL standalone binary
// produced by `bun run build` — not the TS source — to catch anything that only
// breaks once bundled + minified into `dist/fleet` (embedded package.json,
// embedded detection manifests, missing runtime files). No tmux required: every
// case here is a cold one-shot CLI invocation with tmux deliberately unset, so
// it runs on any CI runner and in the compile job right after the build step.
//
// Run: `bun run build && bun test ./e2e/binary.smoke.ts`

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const BIN = join(import.meta.dir, '..', 'dist', 'fleet');
let smokeHome = '';

// Every case runs with tmux unreachable so the binary's degrade-gracefully
// paths are what's exercised (and nothing depends on a live server).
function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [BIN, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    // Point tmux at a socket that cannot exist so any tmux call fails cleanly.
    env: {
      ...process.env,
      TMUX: '',
      TMUX_TMPDIR: join(smokeHome, 'tmux'),
      HOME: smokeHome,
      XDG_CONFIG_HOME: join(smokeHome, 'config'),
    },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`compiled binary missing at ${BIN} — run \`bun run build\` before test:smoke`);
  }
  smokeHome = mkdtempSync(join(tmpdir(), 'fleet-smoke-'));
});

afterAll(() => {
  if (smokeHome) rmSync(smokeHome, { recursive: true, force: true });
});

describe('compiled binary smoke', () => {
  test('--version prints the embedded package version and exits 0', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`fleet ${pkg.version}`);
  });

  test('--help renders the banner and exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Dashboard');
    expect(r.stdout).toContain('fleet status');
  });

  test('an unknown command exits 1 with a diagnostic on stderr', () => {
    const r = run(['definitely-not-a-command']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });

  test('status --statusline renders the sidebar chip and exits 0 without tmux', () => {
    const r = run(['status', '--statusline']);
    expect(r.code).toBe(0);
    // With no agents (and tmux down) the bar is just the always-present sidebar
    // chip; its range sentinel proves the segment was actually composed.
    expect(r.stdout.trim()).toMatch(/^#\[range=user\|__sidebar__\]#\[fg=cyan\] ☰ #\[norange\]$/);
  });

  test('status <session> reports idle/0 for an unknown session without tmux', () => {
    const r = run(['status', 'no-such-session']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('idle 0');
  });

  test('send with missing args exits 1 with usage', () => {
    const r = run(['send']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Usage: fleet send');
  });
});
