import { existsSync, mkdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runStatusLineInject,
  runStatusLineRemove,
  buildRollupEnableCommands,
  WINDOW_STATUS_FORMAT,
  WINDOW_STATUS_CURRENT_FORMAT,
} from './statusline.ts';

const FLEET_MANAGED_MARKER = '# fleet-managed';
const FLEET_TMUX_LINE = `run-shell "fleet statusline --inject" ${FLEET_MANAGED_MARKER}`;
const FLEET_KEYBIND_SIDEBAR = `bind-key f split-window -hbf -l 34 fleet ${FLEET_MANAGED_MARKER}`;
const FLEET_KEYBIND_POPUP = `bind-key F display-popup -E -w 80% -h 60% fleet ${FLEET_MANAGED_MARKER}`;

// Window state rollup opt-in: gate option + both window-status format overrides,
// built from the same shared format constants as the live enable commands so the
// persisted conf and the live server never drift.
const FLEET_ROLLUP_GATE_LINE = `set -g @fleet_rollup 1 ${FLEET_MANAGED_MARKER}`;
const FLEET_ROLLUP_FORMAT_LINE = `set -g window-status-format "${WINDOW_STATUS_FORMAT}" ${FLEET_MANAGED_MARKER}`;
const FLEET_ROLLUP_CURRENT_FORMAT_LINE = `set -g window-status-current-format "${WINDOW_STATUS_CURRENT_FORMAT}" ${FLEET_MANAGED_MARKER}`;
const FLEET_ROLLUP_LINES = [FLEET_ROLLUP_GATE_LINE, FLEET_ROLLUP_FORMAT_LINE, FLEET_ROLLUP_CURRENT_FORMAT_LINE];

export function resolvePluginDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    if (existsSync(join(dir, 'hooks', 'hooks.json'))) return dir;
  }
  return null;
}

export function fleetPluginDir(): string | null {
  const fromBin = resolve(dirname(process.execPath), '..');
  const fromDev = resolve(import.meta.dir, '../..');
  return resolvePluginDir([fromBin, fromDev]);
}

function marketplaceDir(): string {
  return join(homedir(), '.local', 'share', 'fleet-marketplace');
}

export function tmuxConfPath(): string {
  const xdgConfig = Bun.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const xdgPath = join(xdgConfig, 'tmux', 'tmux.conf');
  if (existsSync(xdgPath)) return xdgPath;

  const legacyPath = join(homedir(), '.tmux.conf');
  if (existsSync(legacyPath)) return legacyPath;

  // Prefer XDG path even when neither exists — caller checks before writing.
  return xdgPath;
}

export function addTmuxConfLine(path: string = tmuxConfPath()): boolean {
  if (!existsSync(path)) return false;

  const contents = readFileSync(path, 'utf8');
  if (contents.includes(FLEET_MANAGED_MARKER)) return true;

  const separator = contents.length === 0 || contents.endsWith('\n') ? '\n' : '\n\n';
  const next = contents + separator + FLEET_TMUX_LINE + '\n';
  writeFileSync(path, next);
  return true;
}

export function removeTmuxConfLine(path: string = tmuxConfPath()): boolean {
  if (!existsSync(path)) return false;

  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(FLEET_MANAGED_MARKER)) return true;

  const filtered = contents
    .split('\n')
    .filter((line) => !line.includes(FLEET_MANAGED_MARKER))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  writeFileSync(path, filtered);
  return true;
}

// Offer the sidebar/popup bindings one at a time. `ask` is injected so tests
// don't touch a TTY. Declined bindings are printed for manual adoption.
// Uninstall needs no changes: removeTmuxConfLine strips every marker line.
export function addTmuxKeybindLines(path: string, ask: (question: string) => boolean): string[] {
  if (!existsSync(path)) return [];
  let contents = readFileSync(path, 'utf8');
  const added: string[] = [];
  const candidates = [
    {
      line: FLEET_KEYBIND_SIDEBAR,
      question: 'Add tmux binding — prefix+f: fleet in a 34-col sidebar split? [y/N] ',
    },
    {
      line: FLEET_KEYBIND_POPUP,
      question: 'Add tmux binding — prefix+F: fleet in a popup? [y/N] ',
    },
  ];
  for (const cand of candidates) {
    if (contents.includes(cand.line)) continue;
    if (ask(cand.question)) {
      contents += (contents.endsWith('\n') || contents.length === 0 ? '' : '\n') + cand.line + '\n';
      added.push(cand.line);
    } else {
      process.stdout.write(`  skipped — add it yourself anytime:\n    ${cand.line}\n`);
    }
  }
  if (added.length > 0) writeFileSync(path, contents);
  return added;
}

// Offer the window state rollup as a single y/N (three conf lines move together:
// the gate option + both window-status format overrides). `ask` is injected so
// tests don't touch a TTY. On yes the lines are appended and returned so the
// caller can apply them live; on no they're printed for manual adoption.
// Idempotent: an already-configured conf (gate line present) is neither re-asked
// nor duplicated. Uninstall needs no changes: removeTmuxConfLine strips every
// marker line.
export function addTmuxRollupLines(path: string, ask: (question: string) => boolean): string[] {
  if (!existsSync(path)) return [];
  let contents = readFileSync(path, 'utf8');
  if (contents.includes(FLEET_ROLLUP_GATE_LINE)) return [];
  if (!ask('Recolor tmux window list by worst agent state (window rollup)? [y/N] ')) {
    process.stdout.write('  skipped — add it yourself anytime:\n');
    for (const line of FLEET_ROLLUP_LINES) process.stdout.write(`    ${line}\n`);
    return [];
  }
  const added: string[] = [];
  for (const line of FLEET_ROLLUP_LINES) {
    if (contents.includes(line)) continue;
    contents += (contents.endsWith('\n') || contents.length === 0 ? '' : '\n') + line + '\n';
    added.push(line);
  }
  if (added.length > 0) writeFileSync(path, contents);
  return added;
}

function askYesNo(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  try {
    const n = readSync(0, buf, 0, 64, null);
    return /^y/i.test(buf.subarray(0, n).toString().trim());
  } catch {
    return false;
  }
}

function ensureMarketplace(fleetDir: string): string {
  const mpDir = marketplaceDir();
  const mpMeta = join(mpDir, '.claude-plugin');
  mkdirSync(mpMeta, { recursive: true });

  writeFileSync(
    join(mpMeta, 'marketplace.json'),
    JSON.stringify(
      {
        name: 'fleet-local',
        description: 'Local Fleet plugin marketplace',
        owner: { name: 'Nick Nisi', email: 'nick@nisi.org' },
        plugins: [{ name: 'fleet', source: './fleet', description: 'Agent dashboard TUI' }],
      },
      null,
      2,
    ) + '\n',
  );

  linkPluginDir(fleetDir, join(mpDir, 'fleet'));

  return mpDir;
}

// Point `link` at `fleetDir`, replacing whatever is already there.
// rmSync removes the symlink itself (it never follows it) and is a no-op when
// nothing exists. existsSync would be wrong here: it *follows* the link, so a
// symlink to a Cellar version removed by `brew upgrade` reports as absent, the
// stale link survives, and symlinkSync then fails with EEXIST.
export function linkPluginDir(fleetDir: string, link: string): void {
  rmSync(link, { force: true });
  symlinkSync(fleetDir, link);
}

export function runInstall(): number {
  const fleetDir = fleetPluginDir();
  if (fleetDir === null) {
    process.stderr.write(
      'fleet install failed: could not find a plugin directory containing hooks/hooks.json.\n' +
        'Without hooks, Claude Code writes no status files and the dashboard stays empty.\n' +
        'If fleet was installed via Homebrew, the package may be missing the hooks/ directory — try upgrading.\n',
    );
    return 1;
  }
  const mpDir = ensureMarketplace(fleetDir);

  const addMp = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'marketplace', 'add', mpDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (addMp.exitCode !== 0) {
    process.stderr.write('Failed to register fleet marketplace\n');
    return addMp.exitCode ?? 1;
  }

  const install = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'install', 'fleet'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (install.exitCode !== 0) return install.exitCode ?? 1;

  const confPath = tmuxConfPath();
  if (addTmuxConfLine(confPath)) {
    process.stdout.write(`Added fleet statusline hook to ${confPath}\n`);
  } else {
    process.stderr.write(`tmux.conf not found at ${confPath} — skipping tmux integration\n`);
  }

  const addedBindings = addTmuxKeybindLines(confPath, askYesNo);
  if (addedBindings.length > 0) {
    process.stdout.write(
      `Added ${addedBindings.length} fleet keybinding(s) — reload with: tmux source-file ${confPath}\n`,
    );
  }

  const addedRollup = addTmuxRollupLines(confPath, askYesNo);
  if (addedRollup.length > 0) {
    // Apply immediately so the recolor takes effect without a config reload.
    for (const cmd of buildRollupEnableCommands()) {
      Bun.spawnSync({ cmd, stdout: 'ignore', stderr: 'ignore' });
    }
    process.stdout.write('Enabled window state rollup — tmux windows recolor by agent state.\n');
  }

  runStatusLineInject();
  return 0;
}

export function runUninstall(): number {
  runStatusLineRemove();

  const confPath = tmuxConfPath();
  if (removeTmuxConfLine(confPath)) {
    process.stdout.write(`Removed fleet statusline hook from ${confPath}\n`);
  }

  const uninstall = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'uninstall', 'fleet'],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  Bun.spawnSync({
    cmd: ['claude', 'plugin', 'marketplace', 'remove', 'fleet-local'],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return uninstall.exitCode ?? 1;
}
