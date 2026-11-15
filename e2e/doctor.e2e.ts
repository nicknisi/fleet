import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateTmux } from './private-tmux.ts';

test('doctor accepts native discovery and checks hooks in the selected Claude profile', async () => {
  const { root, tm, waitFor, close } = privateTmux('fleet-doctor-');
  const home = join(root, 'home');
  const profile = join(root, 'claude-profile');
  const bin = join(root, 'bin');
  for (const path of [home, profile, bin]) mkdirSync(path, { recursive: true });
  const listed = join(root, 'listed');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat '${listed}'\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: profile,
    XDG_CONFIG_HOME: join(root, 'config'),
    TMUX: '',
    PATH: `${bin}:${process.env.PATH}`,
  };
  const run = (args: string[]) =>
    Bun.spawnSync([process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'), ...args], { env });
  try {
    // Give the real Python executable an agent basename, without relying on
    // Linux-only process-title APIs or installing a native model client.
    symlinkSync(Bun.which('python3')!, join(bin, 'codex'));
    const agent = join(root, 'agent.py');
    writeFileSync(agent, "import time\nprint('› Draft',flush=True)\ntime.sleep(90)\n");
    tm('new-session', '-d', '-s', 'agent', '-x', '100', '-y', '35', join(bin, 'codex'), '-u', agent);
    tm('rename-window', '-t', 'agent', 'codex');
    await waitFor(() => tm('capture-pane', '-p', '-t', 'agent').includes('› Draft'));
    env.TMUX = `${join(root, 'tmux.sock')},${tm('display-message', '-p', '#{pid}')},0`;
    writeFileSync(listed, 'No plugins installed\n');
    const discovered = run(['list', '--json']);
    expect(discovered.exitCode).toBe(0);
    expect(
      JSON.parse(discovered.stdout.toString()).agents.some((a: { agentType: string }) => a.agentType === 'codex'),
    ).toBe(true);
    const optional = run(['doctor']);
    expect(optional.exitCode).toBe(0);
    expect(optional.stdout.toString()).toContain('native panes use discovery');
    expect(optional.stdout.toString()).not.toContain('fleet hooks:');

    // A healthy default profile must not mask a broken selected profile.
    const healthy = join(home, '.claude/plugins');
    mkdirSync(join(healthy, 'cache/fleet/hooks'), { recursive: true });
    writeFileSync(join(healthy, 'cache/fleet/hooks/hooks.json'), '{}');
    writeFileSync(
      join(healthy, 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'fleet@local': [{ installPath: join(healthy, 'cache/fleet') }] } }),
    );
    mkdirSync(join(profile, 'plugins'), { recursive: true });
    const selectedPlugin = join(profile, 'plugins/cache/fleet');
    writeFileSync(
      join(profile, 'plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'fleet@local': [{ installPath: selectedPlugin }] } }),
    );
    writeFileSync(listed, 'fleet@local\n');
    const broken = run(['doctor']);
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout.toString()).toContain('hook updates unavailable, native discovery still works');
    expect(broken.stdout.toString()).not.toContain('dashboard will stay empty');

    mkdirSync(join(selectedPlugin, 'hooks'), { recursive: true });
    writeFileSync(join(selectedPlugin, 'hooks/hooks.json'), '{}');
    const repaired = run(['doctor']);
    expect(repaired.exitCode).toBe(0);
    expect(repaired.stdout.toString()).toContain('fleet hooks: registered');

    // Required infrastructure failures must remain failures despite optional hooks.
    writeFileSync(
      join(root, 'config/fleet/agents.json'),
      JSON.stringify({ agents: [{ name: 'codex', statusDir: join(root, 'missing-status') }] }),
    );
    expect(run(['doctor']).exitCode).toBe(1);
    writeFileSync(join(root, 'config/fleet/agents.json'), '{"agents":[]}');

    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    expect(run(['doctor']).exitCode).toBe(0);
    // A Codex-only machine may have no Claude executable at all.
    unlinkSync(join(bin, 'claude'));
    symlinkSync(Bun.which('tmux')!, join(bin, 'tmux'));
    env.PATH = bin;
    const noClaude = run(['doctor']);
    expect(noClaude.exitCode).toBe(0);
    expect(noClaude.stdout.toString()).toContain('could not query Claude plugins');
  } finally {
    close();
  }
}, 15000);
