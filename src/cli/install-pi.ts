import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fleetPluginDir } from './install.ts';
import { agentsJsonPath, removeAgentEntry, seededAgentDirs, upsertAgentEntry, withTilde } from './install-codex.ts';
import { PI_STATUS_DIR } from '../agents/config.ts';

// pi (npm: @earendil-works/pi-coding-agent) has no shell-hook config; it loads
// package extensions from `packages` in ~/.pi/agent/settings.json (see pi's
// docs/packages.md). `fleet install pi` registers hooks/pi as a local package so
// pi owns loading. The source directory itself is never copied or symlinked:
// Homebrew's opt path survives upgrades, while a dev checkout tracks the repo.
// Everything is idempotent and reversible; the user's own pi extensions,
// packages, and config are never touched.

const PI_EXTENSIONS_DIR = join(homedir(), '.pi', 'agent', 'extensions');
const PI_EXTENSION_LINK = join(PI_EXTENSIONS_DIR, 'fleet-pi.ts');
// ~-form stored in agents.json (portable, README-documented); loadAgentDirs
// expands the leading ~ back to PI_STATUS_DIR when it reads this.
const PI_STATUS_DIR_CONFIG = '~/.cache/pi-status';

interface PiSettingsDoc {
  packages?: unknown[];
  [key: string]: unknown;
}

function piSettingsPath(): string {
  return join(homedir(), '.pi', 'agent', 'settings.json');
}

// Pi's own installer persists local packages relative to the directory that
// owns settings.json (~/.pi/agent), e.g. `../../Developer/fleet/hooks/pi`.
// Matching both forms keeps fleet's direct settings edit byte-compatible with
// a later `pi remove`.
function canonicalPiPackageSource(packageDir: string): string {
  return relative(dirname(piSettingsPath()), packageDir) || '.';
}

function readPiSettings(path: string): PiSettingsDoc | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PiSettingsDoc;
  } catch {
    return null; // malformed — leave the user's settings untouched
  }
}

function writePiSettings(path: string, doc: PiSettingsDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// --- pure settings helpers (exported for unit tests) -------------------------

// A settings entry points at this fleet checkout when its source string is
// exactly `packageDir` or pi's normalized relative form. A legacy entry
// pointing at a symlinked source is repaired by packageDirsToRemove below
// rather than by string surgery.
export function piPackageEntryMatches(entry: unknown, packageDir: string): boolean {
  const relativeDir = canonicalPiPackageSource(packageDir);
  const matches = (source: string): boolean => source === packageDir || source === relativeDir;
  if (typeof entry === 'string') return matches(entry);
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const source = (entry as { source?: unknown }).source;
  return typeof source === 'string' && matches(source);
}

function upsertPiPackageEntry(packages: unknown[], packageDir: string): unknown[] {
  if (packages.some((entry) => piPackageEntryMatches(entry, packageDir))) return packages;
  return [...packages, packageDir];
}

function removePiPackageEntry(packages: unknown[], packageDir: string): unknown[] {
  return packages.filter((entry) => !piPackageEntryMatches(entry, packageDir));
}

// The old installer linked fleet-pi.ts into ~/.pi/agent/extensions. Read the
// link itself (not the extension content) so uninstall can also remove a
// settings entry that pointed at the symlinked source instead of the realpath.
function legacyPiPackageDir(): string | null {
  try {
    const target = readlinkSync(PI_EXTENSION_LINK);
    const resolvedTarget = target.startsWith('/') ? target : resolve(dirname(PI_EXTENSION_LINK), target);
    return dirname(resolvedTarget);
  } catch {
    return null;
  }
}

// lstat (does not follow the link) so a dangling legacy link still reports
// present and gets removed.
function legacyEntryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function packageDirsToRemove(packageDir: string | null): string[] {
  return Array.from(new Set([packageDir, legacyPiPackageDir()].filter((p): p is string => p !== null)));
}

export function runInstallPi(): number {
  const fleetDir = fleetPluginDir();
  if (fleetDir === null) {
    process.stderr.write(
      'fleet install pi failed: could not find a plugin directory containing hooks/hooks.json.\n' +
        'Without it there is no fleet-pi extension to register with pi.\n' +
        'If fleet was installed via Homebrew, the package may be missing the hooks/ directory — try upgrading.\n',
    );
    return 1;
  }
  const packageDir = join(fleetDir, 'hooks', 'pi');
  const extensionSrc = join(packageDir, 'fleet-pi.ts');
  const manifestSrc = join(packageDir, 'package.json');
  if (!existsSync(extensionSrc) || !existsSync(manifestSrc)) {
    process.stderr.write(`fleet install pi failed: fleet-pi package not found at ${packageDir}\n`);
    return 1;
  }

  // Snapshot agents present BEFORE the mkdir below so a fresh agents.json is
  // seeded without dropping claude/codex (see seededAgentDirs).
  const seed = seededAgentDirs();
  const settingsPath = piSettingsPath();
  const doc = readPiSettings(settingsPath) ?? {};
  const packages = Array.isArray(doc.packages) ? doc.packages : [];
  doc.packages = upsertPiPackageEntry(packages, canonicalPiPackageSource(packageDir));
  writePiSettings(settingsPath, doc);

  // Migrate away from the old ~/.pi/agent/extensions/fleet-pi.ts symlink so pi
  // does not load both the package and the legacy auto-discovered extension.
  const hadLegacyEntry = legacyEntryPresent(PI_EXTENSION_LINK);
  if (hadLegacyEntry) rmSync(PI_EXTENSION_LINK, { force: true });

  process.stdout.write(`Registered ${withTilde(packageDir)} in ${withTilde(settingsPath)}\n`);
  if (hadLegacyEntry) process.stdout.write(`Removed legacy ${withTilde(PI_EXTENSION_LINK)}\n`);

  mkdirSync(PI_STATUS_DIR, { recursive: true });
  process.stdout.write(`Created ${withTilde(PI_STATUS_DIR)}\n`);

  const agentsPath = agentsJsonPath();
  mkdirSync(dirname(agentsPath), { recursive: true });
  upsertAgentEntry(agentsPath, { name: 'pi', statusDir: PI_STATUS_DIR_CONFIG }, seed);
  process.stdout.write(`Registered pi in ${withTilde(agentsPath)}\n`);

  process.stdout.write('\nfleet is now wired into pi. Start pi in a tmux pane to see it on the dashboard.\n');
  process.stdout.write('(In an already-running pi session, run /reload to pick up the package.)\n');
  return 0;
}

export function runUninstallPi(): number {
  const fleetDir = fleetPluginDir();
  const packageDir = fleetDir === null ? null : join(fleetDir, 'hooks', 'pi');
  const settingsPath = piSettingsPath();
  const doc = readPiSettings(settingsPath);
  if (doc && Array.isArray(doc.packages)) {
    let packages = doc.packages;
    for (const dir of packageDirsToRemove(packageDir)) {
      packages = removePiPackageEntry(packages, dir);
    }
    if (packages.length !== doc.packages.length) {
      doc.packages = packages;
      writePiSettings(settingsPath, doc);
      process.stdout.write(`Removed fleet package from ${withTilde(settingsPath)}\n`);
    }
  }

  // Remove the old installer path as a legacy migration. A non-fleet file by
  // this exact name is still fleet-owned install territory; the user's other pi
  // extensions are untouched.
  if (legacyEntryPresent(PI_EXTENSION_LINK)) {
    rmSync(PI_EXTENSION_LINK, { force: true });
    process.stdout.write(`Removed legacy ${withTilde(PI_EXTENSION_LINK)}\n`);
  }

  const agentsPath = agentsJsonPath();
  removeAgentEntry(agentsPath, 'pi');
  process.stdout.write(`Unregistered pi from ${withTilde(agentsPath)}\n`);

  // Leave ~/.cache/pi-status in place: harmless, and it may still hold live state
  // for a pi session that is currently running.
  return 0;
}
