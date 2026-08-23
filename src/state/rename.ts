import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isJsonObject, isString, type JsonValue } from '../json.ts';

// Rename store lives under the XDG cache root (mirrors the ~/.cache/<name>-status
// convention in config.ts) so a user rename survives a fleet restart.
export function renamesPath(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(cache, 'fleet', 'renames.json');
}

// Flat session→label map. A corrupt, missing, or ill-typed file yields an empty
// map rather than throwing — a bad store must never crash the TUI.
export function loadRenames(path: string = renamesPath()): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  try {
    // SAFETY: JSON.parse returns any; JsonValue is the sound type of any JSON document.
    const data = JSON.parse(readFileSync(path, 'utf-8')) as JsonValue;
    if (isJsonObject(data)) {
      for (const [k, v] of Object.entries(data)) {
        if (isString(v) && v.length > 0) out.set(k, v);
      }
    }
  } catch {
    // Corrupt store — fall back to no renames rather than crash the TUI.
  }
  return out;
}

// Re-reads before writing so concurrent fleet instances don't clobber each
// other's renames (last-writer-wins per key, not per file). An empty/blank
// label deletes the key — a natural "clear rename".
export function saveRename(session: string, label: string, path: string = renamesPath()): void {
  const map = loadRenames(path);
  const trimmed = label.trim();
  if (trimmed.length === 0) map.delete(session);
  else map.set(session, trimmed);
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[k] = v;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj) + '\n');
}
