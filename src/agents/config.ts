import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentDir {
  name: string;
  statusDir: string;
}

const HOME = homedir();

// Claude's canonical status dir. Named once here (the read side) so it is
// testable and can be asserted equal to what hooks/lib.sh writes (the write
// side). These two must never drift: a mismatch silently breaks detection.
export const CLAUDE_STATUS_DIR = join(HOME, '.cache', 'claude-status');

// Codex's canonical status dir (Phase 3). Mirrors CLAUDE_STATUS_DIR's naming
// (~/.cache/<agent>-status) because Phase 2 kept claude at ~/.cache/claude-status
// rather than moving everything under ~/.cache/fleet/. This is the single source
// of truth: install-codex.ts (mkdir + agents.json entry) and the Codex hook's
// FLEET_STATUS_DIR must resolve to this same dir or detection silently breaks.
export const CODEX_STATUS_DIR = join(HOME, '.cache', 'codex-status');

// pi's canonical status dir. Same naming + same drift contract as the others:
// install-pi.ts (mkdir + agents.json entry) and the fleet-pi extension's
// FLEET_PI_STATUS_DIR default must resolve here or pi detection silently breaks.
export const PI_STATUS_DIR = join(HOME, '.cache', 'pi-status');

export function loadAgentDirs(): AgentDir[] {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(HOME, '.config');

  const newConfig = join(configDir, 'fleet', 'agents.json');
  if (existsSync(newConfig)) {
    try {
      const data = JSON.parse(readFileSync(newConfig, 'utf-8')) as { agents?: unknown[] };
      if (data.agents && Array.isArray(data.agents)) {
        if (data.agents.length === 0) return []; // deliberately empty — no fallback
        // Per-entry validation: one malformed entry must not discard the whole
        // file (the catch below would silently drop every valid agent).
        const valid = data.agents
          .filter(
            (a): a is AgentDir =>
              typeof a === 'object' &&
              a !== null &&
              typeof (a as AgentDir).name === 'string' &&
              typeof (a as AgentDir).statusDir === 'string',
          )
          .map((a) => ({
            name: a.name,
            statusDir: a.statusDir.replace(/^~/, HOME),
          }));
        if (valid.length > 0) return valid;
      }
    } catch {
      // Fall through to legacy
    }
  }

  const legacyConfig = join(configDir, 'agent-status', 'agents.conf');
  if (existsSync(legacyConfig)) {
    const dirs: AgentDir[] = [];
    const content = readFileSync(legacyConfig, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.length === 0) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      const dir = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^\$HOME/, HOME);
      dirs.push({ name, statusDir: dir });
    }
    if (dirs.length > 0) return dirs;
  }

  const fallback: AgentDir[] = [];
  if (existsSync(CLAUDE_STATUS_DIR)) fallback.push({ name: 'claude', statusDir: CLAUDE_STATUS_DIR });
  if (existsSync(CODEX_STATUS_DIR)) fallback.push({ name: 'codex', statusDir: CODEX_STATUS_DIR });
  if (existsSync(PI_STATUS_DIR)) fallback.push({ name: 'pi', statusDir: PI_STATUS_DIR });

  return fallback;
}
