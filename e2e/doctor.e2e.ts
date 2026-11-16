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
    const python = Bun.spawnSync(['python3', '-c', 'import sys; print(sys.executable)']);
    expect(python.exitCode).toBe(0);
    symlinkSync(python.stdout.toString().trim(), join(bin, 'codex'));
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
      JSON.stringify({ plugins: { 'fleet@fleet-local': [{ installPath: selectedPlugin }] } }),
    );
    writeFileSync(listed, 'fleet@fleet-local\n');
    const broken = run(['doctor']);
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout.toString()).toContain('hook updates unavailable, native discovery still works');
    expect(broken.stdout.toString()).not.toContain('dashboard will stay empty');

    mkdirSync(join(selectedPlugin, 'hooks'), { recursive: true });
    writeFileSync(join(selectedPlugin, 'hooks/hooks.json'), '{}');
    const marketplace = join(home, '.local/share/fleet-marketplace');
    mkdirSync(marketplace, { recursive: true });
    symlinkSync(selectedPlugin, join(marketplace, 'fleet'));
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
    const failedQuery = run(['doctor']);
    expect(failedQuery.exitCode).toBe(0);
    expect(failedQuery.stdout.toString()).toContain('could not query Claude plugins');
    unlinkSync(join(selectedPlugin, 'hooks/hooks.json'));
    const recordedBroken = run(['doctor']);
    expect(recordedBroken.exitCode).toBe(1);
    expect(recordedBroken.stdout.toString()).toContain('hook updates unavailable');
    // A Codex-only machine may have no Claude executable at all.
    unlinkSync(join(bin, 'claude'));
    symlinkSync(Bun.which('tmux')!, join(bin, 'tmux'));
    env.PATH = bin;
    expect(run(['doctor']).exitCode).toBe(1);
    writeFileSync(
      join(profile, 'plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'fleet@fleet-local': [{}] } }),
    );
    const missingInstallPath = run(['doctor']);
    expect(missingInstallPath.exitCode).toBe(1);
    expect(missingInstallPath.stdout.toString()).toContain('hook updates unavailable');
    writeFileSync(join(profile, 'plugins/installed_plugins.json'), '{"plugins":{}}');
    const noClaude = run(['doctor']);
    expect(noClaude.exitCode).toBe(0);
    expect(noClaude.stdout.toString()).toContain('could not query Claude plugins');
    writeFileSync(join(profile, 'plugins/installed_plugins.json'), 'corrupt metadata');
    expect(run(['doctor']).exitCode).toBe(0);
    // The maintained marketplace source is shared across profiles, not their
    // per-profile plugin cache. Its failure is advisory without a Fleet install.
    unlinkSync(join(marketplace, 'fleet'));
    const missingOptionalSource = run(['doctor']);
    expect(missingOptionalSource.exitCode).toBe(0);
    expect(missingOptionalSource.stdout.toString()).toContain('marketplace source');
    mkdirSync(join(selectedPlugin, 'hooks'), { recursive: true });
    writeFileSync(join(selectedPlugin, 'hooks/hooks.json'), '{}');
    writeFileSync(
      join(profile, 'plugins/installed_plugins.json'),
      JSON.stringify({
        plugins: { 'fleet@fleet-local': [{ installPath: selectedPlugin }] },
      }),
    );
    expect(run(['doctor']).exitCode).toBe(1);
    // Confirmed CLI absence takes precedence over stale recorded metadata,
    // including broken hooks and the optional marketplace source.
    unlinkSync(join(selectedPlugin, 'hooks/hooks.json'));
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "No plugins installed\\n"\n', { mode: 0o755 });
    const confirmedAbsent = run(['doctor']);
    expect(confirmedAbsent.exitCode).toBe(0);
    expect(confirmedAbsent.stdout.toString()).toContain('not installed; native panes use discovery');
    expect(confirmedAbsent.stdout.toString()).not.toContain('fleet hooks:');
    expect(confirmedAbsent.stdout.toString()).toContain('marketplace source');
  } finally {
    close();
  }
}, 15000);

for (const scenario of ['missing marketplace', 'malformed metadata', 'external marketplace']) {
  test(`doctor reports ${scenario} for a recorded install without crashing`, () => {
    const { root, tm, close } = privateTmux('fleet-doctor-recorded-');
    try {
      tm('new-session', '-d', '-s', 'fixture');
      const home = join(root, 'home');
      const profile = join(root, 'profile');
      const bin = join(root, 'bin');
      const plugin = join(profile, 'plugins/cache/fleet');
      mkdirSync(join(plugin, 'hooks'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(plugin, 'hooks/hooks.json'), '{}');
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
      const manifest = join(profile, 'plugins/installed_plugins.json');
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: profile,
        XDG_CONFIG_HOME: join(root, 'config'),
        TMUX: `${join(root, 'tmux.sock')},${tm('display-message', '-p', '#{pid}')},0`,
        PATH: `${bin}:${process.env.PATH}`,
      };
      const entries =
        scenario === 'malformed metadata' ? [null, {}, [null], [{ installPath: 42 }]] : [[{ installPath: plugin }]];
      const key = scenario === 'external marketplace' ? 'fleet@external' : 'fleet@fleet-local';
      for (const { entry, listed } of entries.flatMap((entry) => [
        { entry, listed: false },
        { entry, listed: true },
      ])) {
        writeFileSync(manifest, JSON.stringify({ plugins: { [key]: entry } }));
        writeFileSync(join(bin, 'claude'), listed ? `#!/bin/sh\nprintf '${key}\\n'\n` : '#!/bin/sh\nexit 2\n', {
          mode: 0o755,
        });
        const result = Bun.spawnSync([process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet'), 'doctor'], {
          env,
        });
        const output = result.stdout.toString();
        expect(result.exitCode).toBe(scenario === 'external marketplace' ? 0 : 1);
        expect(output).toContain('focus-events:');
        if (scenario === 'missing marketplace') {
          expect(output).toContain('marketplace source:');
          expect(output).toContain(`${join(home, '.local/share/fleet-marketplace')} (missing)`);
        } else if (scenario === 'malformed metadata') {
          expect(output).toContain('malformed Fleet metadata');
        } else {
          expect(output).toContain('fleet hooks: registered');
          expect(output).not.toContain('marketplace source:');
        }
        expect(result.stderr.toString()).not.toContain('TypeError');
      }
    } finally {
      close();
    }
  }, 15000);
}
