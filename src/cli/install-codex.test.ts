import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCodexHooks,
  ensureCodexFeatures,
  removeAgentEntry,
  removeCodexFeatures,
  removeCodexHooks,
  upsertAgentEntry,
} from './install-codex.ts';

// A representative absolute hook-script path (what install writes into hooks.json).
const SCRIPT = '/Users/you/.local/share/fleet/plugin/hooks/codex/codex-hook.sh';

interface HookCmd {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookEntry {
  hooks?: HookCmd[];
}
interface HooksDoc {
  hooks?: Record<string, HookEntry[]>;
}
interface AgentsDoc {
  agents: { name: string; statusDir: string }[];
}

let workDir: string;
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-codex-test-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('addCodexHooks / removeCodexHooks', () => {
  test('creates PreToolUse+Stop fleet entries on a missing file', () => {
    const p = join(workDir, 'hooks.json');
    addCodexHooks(p, SCRIPT);
    const doc = readJson<HooksDoc>(p);
    expect(doc.hooks!.PreToolUse).toHaveLength(1);
    expect(doc.hooks!.Stop).toHaveLength(1);
    expect(doc.hooks!.PreToolUse![0]!.hooks![0]!.command).toBe(`bash ${SCRIPT} PreToolUse`);
    expect(doc.hooks!.Stop![0]!.hooks![0]!.command).toBe(`bash ${SCRIPT} Stop`);
    expect(doc.hooks!.PreToolUse![0]!.hooks![0]!.timeout).toBe(5000);
  });

  test('running twice does not duplicate fleet entries', () => {
    const p = join(workDir, 'hooks.json');
    addCodexHooks(p, SCRIPT);
    const after1 = readFileSync(p, 'utf8');
    addCodexHooks(p, SCRIPT);
    expect(readFileSync(p, 'utf8')).toBe(after1);
    const doc = readJson<HooksDoc>(p);
    expect(doc.hooks!.PreToolUse).toHaveLength(1);
    expect(doc.hooks!.Stop).toHaveLength(1);
  });

  test('preserves a pre-existing user entry, appends fleet, and removes only fleet on uninstall', () => {
    const p = join(workDir, 'hooks.json');
    writeFileSync(
      p,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'claude-status-hook PreToolUse', timeout: 5000 }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'claude-status-hook Stop', timeout: 5000 }] }],
          },
        },
        null,
        2,
      ),
    );

    addCodexHooks(p, SCRIPT);
    let doc = readJson<HooksDoc>(p);
    expect(doc.hooks!.PreToolUse).toHaveLength(2);
    expect(doc.hooks!.PreToolUse![0]!.hooks![0]!.command).toBe('claude-status-hook PreToolUse'); // user preserved, first
    expect(doc.hooks!.PreToolUse![1]!.hooks![0]!.command).toContain('codex-hook.sh');

    removeCodexHooks(p);
    doc = readJson<HooksDoc>(p);
    expect(doc.hooks!.PreToolUse).toHaveLength(1);
    expect(doc.hooks!.PreToolUse![0]!.hooks![0]!.command).toBe('claude-status-hook PreToolUse');
    expect(doc.hooks!.Stop).toHaveLength(1);
    expect(doc.hooks!.Stop![0]!.hooks![0]!.command).toBe('claude-status-hook Stop');
  });

  test('removeCodexHooks deletes an event key when only fleet entries were present', () => {
    const p = join(workDir, 'hooks.json');
    addCodexHooks(p, SCRIPT);
    removeCodexHooks(p);
    const doc = readJson<HooksDoc>(p);
    expect(doc.hooks!.PreToolUse).toBeUndefined();
    expect(doc.hooks!.Stop).toBeUndefined();
  });

  test('throws on malformed hooks.json and leaves the file untouched (never clobber)', () => {
    const p = join(workDir, 'hooks.json');
    const junk = '{ not valid json ]';
    writeFileSync(p, junk);
    expect(() => addCodexHooks(p, SCRIPT)).toThrow();
    expect(readFileSync(p, 'utf8')).toBe(junk);
  });

  test('removeCodexHooks throws on malformed hooks.json (runUninstallCodex catches this)', () => {
    const p = join(workDir, 'hooks.json');
    const junk = '{ not valid json ]';
    writeFileSync(p, junk);
    expect(() => removeCodexHooks(p)).toThrow();
    expect(readFileSync(p, 'utf8')).toBe(junk); // untouched
  });

  test('removeCodexHooks is a no-op on a missing file', () => {
    expect(() => removeCodexHooks(join(workDir, 'nope.json'))).not.toThrow();
  });
});

describe('ensureCodexFeatures', () => {
  test('missing config creates [features] hooks = true', () => {
    const p = join(workDir, 'config.toml');
    ensureCodexFeatures(p);
    const t = readFileSync(p, 'utf8');
    expect(t).toContain('[features]');
    expect(t).toMatch(/hooks\s*=\s*true/);
  });

  test('inserts hooks = true under an existing [features] without duplicating the header', () => {
    const p = join(workDir, 'config.toml');
    writeFileSync(p, '[features]\nother = 1\n\n[model]\nname = "x"\n');
    ensureCodexFeatures(p);
    const t = readFileSync(p, 'utf8');
    expect((t.match(/\[features\]/g) ?? []).length).toBe(1);
    expect(t).toMatch(/hooks\s*=\s*true/);
    expect(t).toContain('other = 1');
    expect(t).toContain('[model]');
  });

  test('flips hooks = false to true', () => {
    const p = join(workDir, 'config.toml');
    writeFileSync(p, '[features]\nhooks = false\n');
    ensureCodexFeatures(p);
    const t = readFileSync(p, 'utf8');
    expect(t).toMatch(/hooks\s*=\s*true/);
    expect(t).not.toMatch(/hooks\s*=\s*false/);
  });

  test('already-true is a byte-identical no-op', () => {
    const p = join(workDir, 'config.toml');
    const before = '[features]\nhooks = true\n';
    writeFileSync(p, before);
    ensureCodexFeatures(p);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });
});

describe('removeCodexFeatures', () => {
  test('leaves hooks = true when other hook entries remain, strips it when none do', () => {
    const cfg = join(workDir, 'config.toml');
    const hooks = join(workDir, 'hooks.json');
    writeFileSync(cfg, '[features]\nhooks = true\n');

    // A user hook remains -> leave the flag on.
    writeFileSync(
      hooks,
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'claude-status-hook PreToolUse' }] }] } }),
    );
    removeCodexFeatures(cfg, hooks);
    expect(readFileSync(cfg, 'utf8')).toMatch(/hooks\s*=\s*true/);

    // No hooks remain -> strip the flag (header stays).
    writeFileSync(hooks, JSON.stringify({ hooks: {} }));
    removeCodexFeatures(cfg, hooks);
    const t = readFileSync(cfg, 'utf8');
    expect(t).not.toMatch(/hooks\s*=\s*true/);
    expect(t).toContain('[features]');
  });
});

describe('upsertAgentEntry / removeAgentEntry', () => {
  test('adds codex without dropping claude and is a byte-identical no-op on re-run', () => {
    const p = join(workDir, 'agents.json');
    writeFileSync(p, JSON.stringify({ agents: [{ name: 'claude', statusDir: '~/.cache/claude-status' }] }, null, 2));

    upsertAgentEntry(p, { name: 'codex', statusDir: '~/.cache/codex-status' });
    const doc = readJson<AgentsDoc>(p);
    expect(doc.agents.map((a) => a.name).sort()).toEqual(['claude', 'codex']);

    const after1 = readFileSync(p, 'utf8');
    upsertAgentEntry(p, { name: 'codex', statusDir: '~/.cache/codex-status' });
    expect(readFileSync(p, 'utf8')).toBe(after1);
  });

  test('synthesizes from the seed when agents.json is missing (does not drop claude)', () => {
    const p = join(workDir, 'agents.json');
    upsertAgentEntry(p, { name: 'codex', statusDir: '~/.cache/codex-status' }, [
      { name: 'claude', statusDir: '/home/u/.cache/claude-status' },
    ]);
    const doc = readJson<AgentsDoc>(p);
    expect(doc.agents.map((a) => a.name).sort()).toEqual(['claude', 'codex']);
  });

  test('removeAgentEntry drops codex and keeps the rest', () => {
    const p = join(workDir, 'agents.json');
    writeFileSync(
      p,
      JSON.stringify({
        agents: [
          { name: 'claude', statusDir: '~/.cache/claude-status' },
          { name: 'codex', statusDir: '~/.cache/codex-status' },
        ],
      }),
    );
    removeAgentEntry(p, 'codex');
    const doc = readJson<AgentsDoc>(p);
    expect(doc.agents.map((a) => a.name)).toEqual(['claude']);
  });
});
