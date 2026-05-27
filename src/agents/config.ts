import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentDir {
  name: string;
  statusDir: string;
}

const HOME = homedir();

export function loadAgentDirs(): AgentDir[] {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(HOME, '.config');

  const newConfig = join(configDir, 'fleet', 'agents.json');
  if (existsSync(newConfig)) {
    try {
      const data = JSON.parse(readFileSync(newConfig, 'utf-8')) as { agents?: AgentDir[] };
      if (data.agents && Array.isArray(data.agents)) {
        return data.agents.map((a) => ({
          name: a.name,
          statusDir: a.statusDir.replace(/^~/, HOME),
        }));
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
  const claudeDir = join(HOME, '.cache', 'claude-status');
  if (existsSync(claudeDir)) fallback.push({ name: 'claude', statusDir: claudeDir });
  const piDir = join(HOME, '.cache', 'pi-status');
  if (existsSync(piDir)) fallback.push({ name: 'pi', statusDir: piDir });

  return fallback;
}
