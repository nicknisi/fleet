import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fleetPluginDir, linkPluginDir } from './install.ts';
import { agentsJsonPath, removeAgentEntry, seededAgentDirs, upsertAgentEntry, withTilde } from './install-codex.ts';
import { PI_STATUS_DIR } from '../agents/config.ts';

// pi (npm: @mariozechner/pi-coding-agent) has no shell-hook config; it loads
// TypeScript extensions auto-discovered from ~/.pi/agent/extensions/*.ts (see
// pi's docs/extensions.md). `fleet install pi` symlinks fleet's extension there
// — a symlink into the plugin dir so a fleet upgrade is picked up without a
// re-copy; re-running install after a Homebrew upgrade re-points it (linkPluginDir
// replaces even a dangling link). Everything is idempotent and reversible; the
// user's own pi extensions and config are never touched.

const PI_EXTENSIONS_DIR = join(homedir(), '.pi', 'agent', 'extensions');
const PI_EXTENSION_LINK = join(PI_EXTENSIONS_DIR, 'fleet-pi.ts');
// ~-form stored in agents.json (portable, README-documented); loadAgentDirs
// expands the leading ~ back to PI_STATUS_DIR when it reads this.
const PI_STATUS_DIR_CONFIG = '~/.cache/pi-status';

// lstat (does not follow the link) so a dangling symlink still reports present.
function linkPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function runInstallPi(): number {
  const fleetDir = fleetPluginDir();
  if (fleetDir === null) {
    process.stderr.write(
      'fleet install pi failed: could not find a plugin directory containing hooks/hooks.json.\n' +
        'Without it there is no fleet-pi extension to link into pi.\n' +
        'If fleet was installed via Homebrew, the package may be missing the hooks/ directory — try upgrading.\n',
    );
    return 1;
  }
  const extensionSrc = join(fleetDir, 'hooks', 'pi', 'fleet-pi.ts');
  if (!existsSync(extensionSrc)) {
    process.stderr.write(`fleet install pi failed: fleet-pi extension not found at ${extensionSrc}\n`);
    return 1;
  }

  // Snapshot agents present BEFORE the mkdir below so a fresh agents.json is
  // seeded without dropping claude/codex (see seededAgentDirs).
  const seed = seededAgentDirs();

  mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
  linkPluginDir(extensionSrc, PI_EXTENSION_LINK); // rm + symlink; replaces a stale/dangling link
  process.stdout.write(`Linked ${withTilde(PI_EXTENSION_LINK)} -> ${extensionSrc}\n`);

  mkdirSync(PI_STATUS_DIR, { recursive: true });
  process.stdout.write(`Created ${withTilde(PI_STATUS_DIR)}\n`);

  const agentsPath = agentsJsonPath();
  mkdirSync(dirname(agentsPath), { recursive: true });
  upsertAgentEntry(agentsPath, { name: 'pi', statusDir: PI_STATUS_DIR_CONFIG }, seed);
  process.stdout.write(`Registered pi in ${withTilde(agentsPath)}\n`);

  process.stdout.write('\nfleet is now wired into pi. Start pi in a tmux pane to see it on the dashboard.\n');
  process.stdout.write('(In an already-running pi session, run /reload to pick up the extension.)\n');
  return 0;
}

export function runUninstallPi(): number {
  // Remove only fleet's extension symlink; the user's own pi extensions stay.
  if (linkPresent(PI_EXTENSION_LINK)) {
    rmSync(PI_EXTENSION_LINK, { force: true });
    process.stdout.write(`Removed ${withTilde(PI_EXTENSION_LINK)}\n`);
  }

  const agentsPath = agentsJsonPath();
  removeAgentEntry(agentsPath, 'pi');
  process.stdout.write(`Unregistered pi from ${withTilde(agentsPath)}\n`);

  // Leave ~/.cache/pi-status in place: harmless, and it may still hold live state
  // for a pi session that is currently running.
  return 0;
}
