import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piDefault, { buildPiStatusLine, fleetPiLabel } from './fleet-pi.ts';
import { parseStatusFile } from '../../src/state/hooks.ts';

describe('fleetPiLabel', () => {
  test('bash: collapses whitespace and truncates to 48 chars', () => {
    expect(fleetPiLabel('bash', { command: 'npm    test   -- --watch --coverage --reporter verbose extra' })).toBe(
      'Bash: npm test -- --watch --coverage --reporter verbos',
    );
  });

  test('bash: empty/absent command falls back to bare "Bash"', () => {
    expect(fleetPiLabel('bash', { command: '' })).toBe('Bash');
    expect(fleetPiLabel('bash', {})).toBe('Bash');
  });

  test('edit/write/read: basename only, capitalized tool', () => {
    expect(fleetPiLabel('edit', { path: '/Users/x/src/auth.ts' })).toBe('Edit: auth.ts');
    expect(fleetPiLabel('write', { path: '/tmp/foo/bar.md' })).toBe('Write: bar.md');
    expect(fleetPiLabel('read', { path: 'README.md' })).toBe('Read: README.md');
  });

  test('unknown tool: capitalized name, no colon', () => {
    expect(fleetPiLabel('grep', { pattern: 'x' })).toBe('Grep');
    expect(fleetPiLabel('list', {})).toBe('List');
  });

  test('missing/non-object args never throws', () => {
    expect(fleetPiLabel('bash', undefined)).toBe('Bash');
    expect(fleetPiLabel('edit', null)).toBe('Edit');
    expect(fleetPiLabel('', {})).toBe('');
  });
});

describe('buildPiStatusLine', () => {
  test('round-trips through fleet parseStatusFile with the exact schema', () => {
    const line = buildPiStatusLine('working', '%3', 'projects', 'Bash: npm test', 1783136479, 17136);
    const parsed = parseStatusFile(line);
    expect(parsed).toEqual({
      state: 'working',
      pane: '%3',
      session: 'projects',
      tool: 'Bash: npm test',
      ts: 1783136479,
      tmux_pid: 17136,
    });
  });

  test('escapes quotes/newlines in the label so the file stays valid JSON', () => {
    const line = buildPiStatusLine('working', '%1', 's', 'Bash: echo "hi"\nrm -rf', 1, 2);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(parseStatusFile(line)?.tool).toBe('Bash: echo "hi"\nrm -rf');
  });
});

describe('extension event wiring', () => {
  let statusDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    statusDir = mkdtempSync(join(tmpdir(), 'fleet-pi-test-'));
    saved = {
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      FLEET_PI_STATUS_DIR: process.env.FLEET_PI_STATUS_DIR,
    };
    process.env.FLEET_PI_STATUS_DIR = statusDir;
  });

  afterEach(() => {
    rmSync(statusDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Capture the handlers the extension registers so the test can fire them.
  function loadWithTmux(pane: string): Record<string, (e?: unknown) => void> {
    process.env.TMUX = '/tmp/fake-tmux,1,0';
    process.env.TMUX_PANE = pane;
    const handlers: Record<string, (e?: unknown) => void> = {};
    const mockPi = {
      on(event: string, handler: (e?: unknown) => void): void {
        handlers[event] = handler;
      },
    };
    piDefault(mockPi as unknown as Parameters<typeof piDefault>[0]);
    return handlers;
  }

  const readStatus = (paneNum: string): ReturnType<typeof parseStatusFile> =>
    parseStatusFile(readFileSync(join(statusDir, `${paneNum}.status`), 'utf8'));

  test('agent_start writes working; tool_execution_start enriches the label; agent_end writes done', () => {
    const h = loadWithTmux('%42');

    h.agent_start?.();
    expect(readStatus('42')?.state).toBe('working');
    expect(readStatus('42')?.pane).toBe('%42');

    h.tool_execution_start?.({ toolName: 'bash', args: { command: 'bun test' } });
    let s = readStatus('42');
    expect(s?.state).toBe('working');
    expect(s?.tool).toBe('Bash: bun test');

    h.agent_end?.();
    s = readStatus('42');
    expect(s?.state).toBe('done');
  });

  test('session_shutdown removes the status file', () => {
    const h = loadWithTmux('%7');
    h.agent_start?.();
    expect(existsSync(join(statusDir, '7.status'))).toBe(true);
    h.session_shutdown?.();
    expect(existsSync(join(statusDir, '7.status'))).toBe(false);
  });

  test('outside tmux: registers no handlers and writes nothing', () => {
    delete process.env.TMUX;
    process.env.TMUX_PANE = '%1';
    const handlers: Record<string, (e?: unknown) => void> = {};
    const mockPi = {
      on(event: string, handler: (e?: unknown) => void): void {
        handlers[event] = handler;
      },
    };
    piDefault(mockPi as unknown as Parameters<typeof piDefault>[0]);
    expect(Object.keys(handlers)).toHaveLength(0);
    // status dir stays empty
    writeFileSync(join(statusDir, 'sentinel'), 'x'); // prove the dir is otherwise empty of .status
    expect(existsSync(join(statusDir, '1.status'))).toBe(false);
  });
});
