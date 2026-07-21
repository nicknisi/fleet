import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fleetPluginDir, linkPluginDir } from './install.ts';
import { CODEX_STATUS_DIR, loadAgentDirs, type AgentDir } from '../agents/config.ts';

// Codex is configured entirely by editing its own files — no marketplace, no
// `claude plugin` CLI, no $CLAUDE_PLUGIN_ROOT. `fleet install codex` is a
// distinct path from the Claude installer; everything here is idempotent and
// surgically reversible so the user's own Codex hooks/config survive uninstall.

// Codex fires exactly these two events (verified in ~/.codex/hooks.json).
const CODEX_EVENTS = ['PreToolUse', 'Stop'] as const;

// The observed timeout Codex uses for its own hook entries (ms).
const CODEX_HOOK_TIMEOUT_MS = 5000;

// Substring that identifies a fleet-owned hook entry inside hooks.json, so
// install adds only if absent and uninstall removes exactly ours.
const FLEET_HOOK_MARKER = 'codex-hook.sh';

// --- canonical paths (single source of truth) ---------------------------------
// CODEX_STATUS_DIR (absolute) is owned by config.ts (the read side) so the two
// never drift. The stable symlink gives Codex an upgrade-safe path to reference.
const CODEX_HOOKS_JSON = join(homedir(), '.codex', 'hooks.json');
const CODEX_CONFIG_TOML = join(homedir(), '.codex', 'config.toml');
const STABLE_LINK = join(homedir(), '.local', 'share', 'fleet', 'plugin');
const CODEX_HOOK_SCRIPT = join(STABLE_LINK, 'hooks', 'codex', 'codex-hook.sh');
// Stored ~-form in agents.json (portable, README-documented); loadAgentDirs
// expands the leading ~ back to CODEX_STATUS_DIR when it reads this.
const CODEX_STATUS_DIR_CONFIG = '~/.cache/codex-status';

// Exported so install-pi.ts registers pi in the same agents.json the read path
// resolves — these helpers are agent-agnostic, they just live here.
export function agentsJsonPath(): string {
  // Mirror loadAgentDirs' resolution exactly so install writes where the read
  // path looks.
  const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configDir, 'fleet', 'agents.json');
}

export function withTilde(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// --- hooks.json editor ---------------------------------------------------------
// Codex's hooks.json shape: { hooks: { <Event>: [ { hooks: [ { type, command,
// timeout } ] } ] } }. No `matcher`; timeout is in ms.
interface CodexHookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}
interface CodexHookEntry {
  hooks?: CodexHookCommand[];
}
interface CodexHooksDoc {
  hooks?: Record<string, CodexHookEntry[]>;
}

function codexEntry(script: string, event: string): CodexHookEntry {
  return { hooks: [{ type: 'command', command: `bash ${script} ${event}`, timeout: CODEX_HOOK_TIMEOUT_MS }] };
}

function isFleetEntry(entry: CodexHookEntry): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(FLEET_HOOK_MARKER));
}

// Add fleet's PreToolUse+Stop entries, preserving any the user already has.
// Throws on malformed JSON (the caller aborts without writing — never clobber).
export function addCodexHooks(path: string, script: string): void {
  const doc: CodexHooksDoc = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as CodexHooksDoc)
    : { hooks: {} };
  const hooks = (doc.hooks ??= {});
  for (const ev of CODEX_EVENTS) {
    const arr = (hooks[ev] ??= []);
    if (!arr.some(isFleetEntry)) arr.push(codexEntry(script, ev));
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// Remove exactly fleet's entries; leave the user's own hooks intact.
export function removeCodexHooks(path: string): void {
  if (!existsSync(path)) return;
  const doc = JSON.parse(readFileSync(path, 'utf8')) as CodexHooksDoc;
  if (!doc.hooks) return;
  for (const ev of CODEX_EVENTS) {
    const arr = doc.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((e) => !isFleetEntry(e));
    if (kept.length === 0) delete doc.hooks[ev];
    else doc.hooks[ev] = kept;
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

// True if hooks.json still has ANY hook entry (used to decide whether disabling
// [features] hooks would break the user's own Codex hooks). Malformed => assume
// yes, so we never strip the flag out from under a user we can't read.
function hasAnyHookEntries(hooksJsonPath: string): boolean {
  if (!existsSync(hooksJsonPath)) return false;
  let doc: CodexHooksDoc;
  try {
    doc = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as CodexHooksDoc;
  } catch {
    return true;
  }
  const hooks = doc.hooks ?? {};
  for (const ev of Object.keys(hooks)) {
    const arr = hooks[ev];
    if (Array.isArray(arr) && arr.length > 0) return true;
  }
  return false;
}

// --- config.toml editor (line-based; zero deps, no TOML parser) ----------------
// Ensure `[features] hooks = true`. Never duplicates the [features] header;
// flips an existing `hooks = false` to true; already-true is a byte-identical no-op.
export function ensureCodexFeatures(path: string): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split('\n');
  const featIdx = lines.findIndex((l) => l.trim() === '[features]');
  if (featIdx === -1) {
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    writeFileSync(path, text + sep + '\n[features]\nhooks = true\n');
    return;
  }
  for (let i = featIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('[')) break; // next section — key absent
    if (/^\s*hooks\s*=/.test(line)) {
      if (/^\s*hooks\s*=\s*true\s*$/.test(line)) return; // already on -> no-op
      lines[i] = 'hooks = true'; // flip false -> true
      writeFileSync(path, lines.join('\n'));
      return;
    }
  }
  lines.splice(featIdx + 1, 0, 'hooks = true'); // header present, key absent
  writeFileSync(path, lines.join('\n'));
}

// Strip `hooks = true` ONLY when fleet was the sole reason it was on (no hook
// entries remain in hooksJsonPath). Otherwise leave it — the user's own Codex
// hooks still need it.
export function removeCodexFeatures(configPath: string, hooksJsonPath: string): void {
  if (!existsSync(configPath)) return;
  if (hasAnyHookEntries(hooksJsonPath)) return;
  const lines = readFileSync(configPath, 'utf8').split('\n');
  const featIdx = lines.findIndex((l) => l.trim() === '[features]');
  if (featIdx === -1) return;
  for (let i = featIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('[')) break;
    if (/^\s*hooks\s*=\s*true\s*$/.test(line)) {
      lines.splice(i, 1);
      writeFileSync(configPath, lines.join('\n'));
      return;
    }
  }
}

// --- agents.json merge (non-destructive) --------------------------------------
interface AgentsDoc {
  agents?: AgentDir[];
}

// Add `entry` if absent, preserving every existing agent. When agents.json does
// not exist, `seed` (the currently resolved dirs) supplies the baseline so the
// naive write doesn't drop claude — loadAgentDirs would otherwise early-return an
// array that excludes it.
export function upsertAgentEntry(path: string, entry: AgentDir, seed: AgentDir[] = []): void {
  let agents: AgentDir[] = [...seed];
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as AgentsDoc;
      if (Array.isArray(doc.agents)) agents = doc.agents;
    } catch {
      // Malformed — keep the seed rather than clobbering with just the new entry.
    }
  }
  if (!agents.some((a) => a.name === entry.name)) agents.push(entry);
  writeFileSync(path, JSON.stringify({ agents }, null, 2) + '\n');
}

// Drop an agent by name, keeping the rest. Missing file or absent name is a no-op.
export function removeAgentEntry(path: string, name: string): void {
  if (!existsSync(path)) return;
  let agents: AgentDir[];
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as AgentsDoc;
    agents = Array.isArray(doc.agents) ? doc.agents : [];
  } catch {
    return; // malformed — leave it untouched
  }
  const kept = agents.filter((a) => a.name !== name);
  if (kept.length === agents.length) return; // not present
  writeFileSync(path, JSON.stringify({ agents: kept }, null, 2) + '\n');
}

// Agents present before an install, guaranteed to include a claude entry even
// when ~/.cache/claude-status doesn't exist yet: agents.json PREEMPTS the
// fallback once written, so an agent-first user who later runs Claude would
// otherwise find it hidden. Shared by the codex and pi installers.
export function seededAgentDirs(): AgentDir[] {
  const seed = loadAgentDirs();
  if (!seed.some((a) => a.name === 'claude')) {
    seed.unshift({ name: 'claude', statusDir: '~/.cache/claude-status' });
  }
  return seed;
}

// --- top-level commands --------------------------------------------------------
export function runInstallCodex(): number {
  const fleetDir = fleetPluginDir();
  if (fleetDir === null) {
    process.stderr.write(
      'fleet install codex failed: could not find a plugin directory containing hooks/hooks.json.\n' +
        'Without the Codex hook script there is nothing to point ~/.codex/hooks.json at.\n' +
        'If fleet was installed via Homebrew, the package may be missing the hooks/ directory — try upgrading.\n',
    );
    return 1;
  }

  // Snapshot the agents that exist BEFORE this install (so the mkdir below doesn't
  // pull a half-formed codex into the fallback) — this seeds a fresh agents.json
  // without dropping them.
  const seed = seededAgentDirs();

  // Stable, upgrade-safe path for Codex to reference (no $CLAUDE_PLUGIN_ROOT, and
  // a Homebrew keg path changes on upgrade). Re-pointed on every install.
  mkdirSync(dirname(STABLE_LINK), { recursive: true });
  linkPluginDir(fleetDir, STABLE_LINK);
  process.stdout.write(`Linked ${withTilde(STABLE_LINK)} -> ${fleetDir}\n`);

  mkdirSync(CODEX_STATUS_DIR, { recursive: true });
  process.stdout.write(`Created ${withTilde(CODEX_STATUS_DIR)}\n`);

  mkdirSync(dirname(CODEX_HOOKS_JSON), { recursive: true });
  try {
    addCodexHooks(CODEX_HOOKS_JSON, CODEX_HOOK_SCRIPT);
  } catch {
    process.stderr.write(
      `fleet install codex failed: refusing to edit malformed ${withTilde(CODEX_HOOKS_JSON)}.\n` +
        'Fix or remove the file, then re-run — your Codex config was not modified.\n',
    );
    return 1;
  }
  process.stdout.write(`Added fleet PreToolUse/Stop hooks to ${withTilde(CODEX_HOOKS_JSON)}\n`);

  ensureCodexFeatures(CODEX_CONFIG_TOML);
  process.stdout.write(`Enabled [features] hooks in ${withTilde(CODEX_CONFIG_TOML)}\n`);

  const agentsPath = agentsJsonPath();
  mkdirSync(dirname(agentsPath), { recursive: true });
  upsertAgentEntry(agentsPath, { name: 'codex', statusDir: CODEX_STATUS_DIR_CONFIG }, seed);
  process.stdout.write(`Registered codex in ${withTilde(agentsPath)}\n`);

  process.stdout.write('\nfleet is now wired into Codex. Start codex in a tmux pane to see it on the dashboard.\n');
  return 0;
}

export function runUninstallCodex(): number {
  try {
    removeCodexHooks(CODEX_HOOKS_JSON);
  } catch {
    process.stderr.write(
      `fleet uninstall codex failed: refusing to edit malformed ${withTilde(CODEX_HOOKS_JSON)}.\n` +
        'Fix or remove the file, then re-run — your Codex config was not modified.\n',
    );
    return 1;
  }
  process.stdout.write(`Removed fleet's Codex hooks from ${withTilde(CODEX_HOOKS_JSON)}\n`);

  removeCodexFeatures(CODEX_CONFIG_TOML, CODEX_HOOKS_JSON);

  const agentsPath = agentsJsonPath();
  removeAgentEntry(agentsPath, 'codex');
  process.stdout.write(`Unregistered codex from ${withTilde(agentsPath)}\n`);

  // Leave the status dir and the stable symlink in place: harmless, and the
  // symlink is shared with any future `fleet install codex`.
  return 0;
}
