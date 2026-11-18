import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piDefault, {
  buildPiStatusLine,
  fleetNotifyMessage,
  fleetPiLabel,
  isPiQuestionTool,
  piPromptState,
  tmuxLiteral,
} from './fleet-pi.ts';
import { parseStatusFile } from '../../src/state/hooks.ts';
import type { JsonValue } from '../../src/json.ts';

// Handlers the extension registers, captured by the mock pi below so tests can
// fire them. Event payloads are JSON-shaped (pi serializes tool args as JSON).
interface HandlerMap {
  [event: string]: (event?: JsonValue) => void;
}

interface SavedEnv {
  TMUX: string | undefined;
  TMUX_PANE: string | undefined;
  FLEET_PI_STATUS_DIR: string | undefined;
}

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

describe('isPiQuestionTool', () => {
  test('recognizes native and compatibility-shim question tools case-insensitively', () => {
    expect(isPiQuestionTool('AskUserQuestion')).toBe(true);
    expect(isPiQuestionTool('ask_user_question')).toBe(true);
    expect(isPiQuestionTool('ASK_USER_QUESTION')).toBe(true);
    expect(isPiQuestionTool('bash')).toBe(false);
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
      name: null, // unnamed write: '' on the wire, null after parsing
      ts: 1783136479,
      tmux_pid: 17136,
    });
  });

  test('carries the pi session name when one is set', () => {
    const line = buildPiStatusLine('working', '%3', 'projects', '', 1783136479, 17136, 'Refactor auth module');
    expect(parseStatusFile(line)?.name).toBe('Refactor auth module');
  });

  test('escapes quotes/newlines in the label so the file stays valid JSON', () => {
    const line = buildPiStatusLine('working', '%1', 's', 'Bash: echo "hi"\nrm -rf', 1, 2);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(parseStatusFile(line)?.tool).toBe('Bash: echo "hi"\nrm -rf');
  });
});

describe('extension event wiring', () => {
  let statusDir: string;
  // Each loaded extension's shutdown, so teardown stops its timers even after a failed assertion.
  const shutdowns: Array<() => void> = [];
  let saved: SavedEnv;

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
    for (const shutdown of shutdowns.splice(0)) shutdown();
    rmSync(statusDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Capture the handlers the extension registers so the test can fire them.
  function loadWithTmux(pane: string, getSessionName?: () => string | undefined): HandlerMap {
    process.env.TMUX = '/tmp/fake-tmux,1,0';
    process.env.TMUX_PANE = pane;
    const handlers: HandlerMap = {};
    const mockPi = {
      on(event: string, handler: (event?: JsonValue) => void): void {
        handlers[event] = handler;
      },
      getSessionName,
      events: {
        on(event: string, handler: (event?: JsonValue) => void): void {
          handlers[event] = handler;
        },
      },
    };
    // SAFETY: mockPi implements only the on()/events surface piDefault touches; the
    // captured handler type is deliberately looser than pi's per-event handler types.
    piDefault(mockPi as Parameters<typeof piDefault>[0]);
    shutdowns.push(() => handlers.session_shutdown?.());
    return handlers;
  }

  const readStatus = (paneNum: string): ReturnType<typeof parseStatusFile> =>
    parseStatusFile(readFileSync(join(statusDir, `${paneNum}.status`), 'utf8'));

  test('agent_start writes working; tool_execution_start enriches the label; agent_settled writes done', () => {
    const h = loadWithTmux('%42');

    h.agent_start?.();
    expect(readStatus('42')?.state).toBe('working');
    expect(readStatus('42')?.pane).toBe('%42');

    h.tool_execution_start?.({ toolName: 'bash', args: { command: 'bun test' } });
    let s = readStatus('42');
    expect(s?.state).toBe('working');
    expect(s?.tool).toBe('Bash: bun test');

    h.agent_end?.();
    expect(readStatus('42')?.state).toBe('working'); // a retry or follow-up may still come
    h.agent_settled?.();
    s = readStatus('42');
    expect(s?.state).toBe('done');
  });

  test('without agent_settled (older pi), agent_end writes done after a short delay', async () => {
    process.env.FLEET_PI_DONE_DELAY_MS = '20';
    try {
      const h = loadWithTmux('%14');
      h.agent_start?.();
      h.agent_end?.();
      await new Promise((r) => setTimeout(r, 60));
      expect(readStatus('14')?.state).toBe('done');
    } finally {
      delete process.env.FLEET_PI_DONE_DELAY_MS;
    }
  });

  test('a run that finishes while a dialog is open keeps the dialog state, then reports done', async () => {
    process.env.FLEET_PI_DONE_DELAY_MS = '20';
    try {
      const h = loadWithTmux('%16');
      h.agent_start?.();
      h.agent_end?.();
      h.ui_prompt_start?.({ kind: 'confirm', title: 'Allow?' });
      await new Promise((r) => setTimeout(r, 60)); // the delayed done fires here
      expect(readStatus('16')?.state).toBe('permit');
      h.agent_settled?.();
      expect(readStatus('16')?.state).toBe('permit');
      h.ui_prompt_end?.();
      expect(readStatus('16')?.state).toBe('done');
    } finally {
      delete process.env.FLEET_PI_DONE_DELAY_MS;
    }
  });

  test('a retry that starts right after agent_end keeps working instead of flashing done', async () => {
    process.env.FLEET_PI_DONE_DELAY_MS = '20';
    try {
      const h = loadWithTmux('%15');
      h.agent_start?.();
      h.agent_end?.();
      h.agent_start?.();
      await new Promise((r) => setTimeout(r, 60));
      expect(readStatus('15')?.state).toBe('working');
    } finally {
      delete process.env.FLEET_PI_DONE_DELAY_MS;
    }
  });

  test('a pi confirm dialog writes permit, other dialogs write question, and the run resumes after', () => {
    const h = loadWithTmux('%11');
    h.agent_start?.();
    h.tool_execution_start?.({ toolName: 'bash', args: { command: 'rm -rf dist' } });

    h.ui_prompt_start?.({ kind: 'confirm', title: 'Allow command?' });
    let s = readStatus('11');
    expect(s?.state).toBe('permit');
    expect(s?.tool).toBe('Allow command?');

    h.ui_prompt_end?.();
    s = readStatus('11');
    expect(s?.state).toBe('working');
    expect(s?.tool).toBe('Bash: rm -rf dist');

    h.ui_prompt_start?.({ kind: 'select', title: 'Pick a model' });
    expect(readStatus('11')?.state).toBe('question');
  });

  test('working is re-stamped while pi works, and never over a waiting state', async () => {
    process.env.FLEET_PI_HEARTBEAT_MS = '20';
    try {
      const h = loadWithTmux('%13');
      const file = join(statusDir, '13.status');
      h.agent_start?.();
      const first = statSync(file).mtimeMs;
      await new Promise((r) => setTimeout(r, 80));
      expect(statSync(file).mtimeMs).toBeGreaterThan(first);

      h.ui_prompt_start?.({ kind: 'confirm', title: 'Allow?' });
      await new Promise((r) => setTimeout(r, 80));
      expect(readStatus('13')?.state).toBe('permit');

      h.ui_prompt_end?.();
      h.agent_end?.();
      h.agent_settled?.();
      const done = statSync(file).mtimeMs;
      await new Promise((r) => setTimeout(r, 80));
      expect(statSync(file).mtimeMs).toBe(done);
      expect(readStatus('13')?.state).toBe('done');
    } finally {
      delete process.env.FLEET_PI_HEARTBEAT_MS;
    }
  });

  test('a dialog opened while idle returns to the state it interrupted', () => {
    const h = loadWithTmux('%12');
    h.agent_start?.();
    h.agent_end?.();
    h.agent_settled?.();
    h.ui_prompt_start?.({ kind: 'input' });
    expect(readStatus('12')?.state).toBe('question');
    h.ui_prompt_end?.();
    expect(readStatus('12')?.state).toBe('done');
  });

  test('rpiv ask-user blocked event writes question until the wait ends', () => {
    const h = loadWithTmux('%8');
    h.agent_start?.();
    h.tool_execution_start?.({ toolName: 'ask_user_question', args: {} });

    h['rpiv:ask-user:blocked']?.({ active: true });
    let s = readStatus('8');
    expect(s?.state).toBe('question');
    expect(s?.tool).toBe('Ask User Question');

    h['rpiv:ask-user:blocked']?.({ active: false });
    s = readStatus('8');
    expect(s?.state).toBe('working');
  });

  test('compatibility AskUserQuestion writes question from tool_call until execution ends', () => {
    const h = loadWithTmux('%9');
    h.agent_start?.();
    h.tool_execution_start?.({ toolName: 'AskUserQuestion', args: {} });

    // Another extension may also write working on tool_execution_start; the
    // question write deliberately happens on the later tool_call event.
    h.tool_call?.({ toolName: 'AskUserQuestion' });
    let s = readStatus('9');
    expect(s?.state).toBe('question');
    expect(s?.tool).toBe('Ask User Question');

    h.tool_execution_end?.({ toolName: 'AskUserQuestion' });
    s = readStatus('9');
    expect(s?.state).toBe('working');
    expect(s?.tool).toBe('AskUserQuestion');
  });

  test('session_shutdown removes the status file', () => {
    const h = loadWithTmux('%7');
    h.agent_start?.();
    expect(existsSync(join(statusDir, '7.status'))).toBe(true);
    h.session_shutdown?.();
    expect(existsSync(join(statusDir, '7.status'))).toBe(false);
  });

  test('session_start writes idle carrying the session name', () => {
    const h = loadWithTmux('%13', () => 'Refactor auth module');
    h.session_start?.();
    const s = readStatus('13');
    expect(s?.state).toBe('idle');
    expect(s?.name).toBe('Refactor auth module');
  });

  test('writes the pi session name and refreshes it on session_info_changed', () => {
    let name: string | undefined;
    const h = loadWithTmux('%11', () => name);

    // Unnamed at session start: the write carries no name rather than erasing one.
    h.agent_start?.();
    expect(readStatus('11')?.name).toBeNull();

    // The auto-name (or a /name rename) lands between lifecycle writes; the
    // session_info_changed handler rewrites the current state carrying it.
    name = 'Refactor auth module';
    h.session_info_changed?.({ name });
    expect(readStatus('11')?.name).toBe('Refactor auth module');
    expect(readStatus('11')?.state).toBe('working');

    // A cleared name (undefined from getSessionName) round-trips to null. The
    // handler re-reads pi.getSessionName() rather than trusting the payload.
    name = undefined;
    h.session_info_changed?.({});
    expect(readStatus('11')?.name).toBeNull();
  });

  test('session_info_changed writes nothing before the first lifecycle write', () => {
    const h = loadWithTmux('%12', () => 'Refactor auth module');
    h.session_info_changed?.({ name: 'Refactor auth module' });
    expect(existsSync(join(statusDir, '12.status'))).toBe(false);
  });

  test('outside tmux: registers no handlers and writes nothing', () => {
    delete process.env.TMUX;
    process.env.TMUX_PANE = '%1';
    const handlers: HandlerMap = {};
    const mockPi = {
      on(event: string, handler: (event?: JsonValue) => void): void {
        handlers[event] = handler;
      },
    };
    // SAFETY: mockPi implements only the on() surface piDefault touches.
    piDefault(mockPi as Parameters<typeof piDefault>[0]);
    expect(Object.keys(handlers)).toHaveLength(0);
    // status dir stays empty
    writeFileSync(join(statusDir, 'sentinel'), 'x'); // prove the dir is otherwise empty of .status
    expect(existsSync(join(statusDir, '1.status'))).toBe(false);
  });
});

describe('piPromptState', () => {
  test('confirm asks for permission; every other dialog is a question', () => {
    expect(piPromptState('confirm')).toBe('permit');
    for (const kind of ['select', 'input', 'editor', 'custom']) expect(piPromptState(kind)).toBe('question');
  });
});

describe('fleetNotifyMessage', () => {
  test('matches fleet_notify in hooks/lib.sh', () => {
    expect(fleetNotifyMessage('permit', 'work', 'Allow command?')).toBe('⚠ work (Allow command?)');
    expect(fleetNotifyMessage('question', 'work')).toBe('? work');
    expect(fleetNotifyMessage('done', 'work')).toBe('✓ work');
    expect(fleetNotifyMessage('waiting', 'work')).toBe('⏳ work');
    expect(fleetNotifyMessage('working', 'work')).toBe('');
  });
});

describe('tmuxLiteral', () => {
  test('doubles # so tmux shows formats and #(cmd) literally', () => {
    expect(tmuxLiteral('? work (#(rm -rf ~) #{pane_id})')).toBe('? work (##(rm -rf ~) ##{pane_id})');
    expect(tmuxLiteral('plain')).toBe('plain');
  });
});
