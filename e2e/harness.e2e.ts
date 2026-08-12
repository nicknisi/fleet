// Real-tmux end-to-end harness (test:e2e). Boots a PRIVATE tmux server on its
// own socket (never touching the developer's session), points the compiled
// `dist/fleet` binary at it via $TMUX, and drives representative flows end to
// end: hook/event/scrape fusion, control-mode vs fork transport, pane presence
// reconciliation (Present|Absent|Unknown), acknowledgement, wait, send, approve,
// and the failure outcomes for each.
//
// Isolation: TMUX_TMPDIR + an explicit -S socket keep the server private;
// XDG_CONFIG_HOME points loadAgentDirs() at a temp agents.json whose statusDir
// is a temp dir, so no real ~/.cache or ~/.config is read or written.
//
// The in-process control-mode cases import the refresh modules directly and let
// them read the same private server through process.env.TMUX — the only way to
// exercise the TUI's control transport (the CLI always uses the fork path).
//
// Run: `bun run build && bun test ./e2e/harness.e2e.ts`

import { test, expect, describe, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentDirs, type AgentDir } from '../src/agents/config.ts';
import { fullRefreshStates, fullRefreshStatesTui } from '../src/state/refresh.ts';
import { TmuxControlClient } from '../src/tmux/control.ts';
import { resolvePermitKeys } from '../src/state/permit-keys.ts';
import { sendKeyNames } from '../src/tmux/send.ts';
import { AgentStatus } from '../src/state/types.ts';
import {
  __resetSnapshotCacheForTests,
  snapshotCacheFilePath,
  writeAgentSnapshot,
} from '../src/state/snapshot-cache.ts';

const BIN = join(import.meta.dir, '..', 'dist', 'fleet');
const hasTmux = Bun.spawnSync({ cmd: ['tmux', '-V'], stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const hasBin = existsSync(BIN);
// The whole suite depends on real tmux + the compiled binary. Skipping loudly
// (rather than silently passing) keeps a missing prerequisite honest in CI.
const suite = hasTmux && hasBin ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

let root = '';
let sock = '';
let statusDir = '';
let configDir = '';
let tmuxEnv = '';
let dirs: AgentDir[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tm(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync({ cmd: ['tmux', '-S', sock, ...args], stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
const tmOut = (args: string[]) => tm(args).stdout.trim();

// Spawn the compiled binary against the private server, with the temp XDG home
// so it reads our agents.json. TMUX carries the socket in its first comma-field,
// which is exactly how tmux resolves the server when no -L/-S is passed.
function fleet(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync({
    cmd: [BIN, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TMUX: tmuxEnv, TMUX_TMPDIR: root, XDG_CONFIG_HOME: configDir, ...env },
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

let sessionSeq = 0;
// Create an isolated session and return [sessionName, paneId]. Fixed geometry
// keeps scraped screens deterministic across machines.
function newSession(): { name: string; pane: string } {
  const name = `e2e${++sessionSeq}`;
  tm(['new-session', '-d', '-s', name, '-x', '120', '-y', '40']);
  const pane = tmOut(['list-panes', '-t', name, '-F', '#{pane_id}']).split('\n')[0]!;
  return { name, pane };
}

function statusPath(pane: string): string {
  return join(statusDir, `${pane.replace('%', '')}.status`);
}
function eventsPath(pane: string): string {
  return join(statusDir, `${pane.replace('%', '')}.events.jsonl`);
}

// Write a hook .status file keyed to a real pane id (what hooks/lib.sh writes).
function writeStatus(pane: string, session: string, fields: Record<string, unknown> = {}): void {
  const data = { state: 'idle', pane, session, tool: '', ts: nowSec(), tmux_pid: 0, ...fields };
  writeFileSync(statusPath(pane), JSON.stringify(data) + '\n');
}

// Type literal text onto a pane's shell input line WITHOUT Enter — it renders on
// screen (so capture-pane / the scraper see it) but never executes.
function paintLiteral(pane: string, text: string): void {
  tm(['send-keys', '-t', pane, '-l', '--', text]);
}
async function waitForScreen(pane: string, needle: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (tmOut(['capture-pane', '-p', '-t', pane]).includes(needle)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(40);
  }
}

// `fleet status <session>` prints "<STATE> <needs-you-count>". Return the state.
function statusOf(session: string): string {
  return fleet(['status', session]).stdout.trim().split(' ')[0]!;
}

beforeAll(() => {
  if (!hasTmux || !hasBin) return;
  root = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  sock = join(root, 'srv.sock');
  statusDir = join(root, 'status');
  configDir = join(root, 'config');
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(join(configDir, 'fleet'), { recursive: true });
  // One registered agent ("claude") whose status dir is our temp dir.
  writeFileSync(
    join(configDir, 'fleet', 'agents.json'),
    JSON.stringify({ agents: [{ name: 'claude', statusDir }] }) + '\n',
  );

  // Start the private server (a throwaway holder session keeps it alive between
  // per-test sessions being created and killed), then use its real PID in the
  // synthetic $TMUX value. A zero PID works for most tmux commands but becomes
  // unreliable after a control client attaches and detaches.
  tm(['new-session', '-d', '-s', 'holder', '-x', '80', '-y', '24']);
  tmuxEnv = `${sock},${tmOut(['display-message', '-p', '#{pid}'])},0`;

  // Point in-process module reads at the same private server + temp config, so
  // the control-mode cases and the CLI cases observe one identical world.
  for (const k of ['TMUX', 'TMUX_TMPDIR', 'XDG_CONFIG_HOME']) savedEnv[k] = process.env[k];
  process.env.TMUX = tmuxEnv;
  process.env.TMUX_TMPDIR = root;
  process.env.XDG_CONFIG_HOME = configDir;
  dirs = loadAgentDirs();
});

afterEach(() => {
  if (!sock) return;
  const sessions = tmOut(['list-sessions', '-F', '#{session_name}']);
  for (const name of sessions.split('\n').filter((candidate) => candidate.startsWith('e2e'))) {
    tm(['kill-session', '-t', name]);
  }
  if (existsSync(statusDir)) {
    for (const file of readdirSync(statusDir)) rmSync(join(statusDir, file), { force: true });
  }
});

afterAll(() => {
  if (sock) tm(['kill-server']);
  for (const k of ['TMUX', 'TMUX_TMPDIR', 'XDG_CONFIG_HOME']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

suite('fusion (compiled binary, fork transport)', () => {
  test('hook state drives status: permit / working / idle', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'permit' });
    expect(statusOf(name)).toBe('PERMIT');
    writeStatus(pane, name, { state: 'working' });
    expect(statusOf(name)).toBe('BUSY');
    writeStatus(pane, name, { state: 'idle' });
    expect(statusOf(name)).toBe('IDLE');
    tm(['kill-session', '-t', name]);
  });

  test('a Stop event fuses to DONE over an idle hook', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    // Stop with no tool_use / background => turn finished => DONE.
    writeFileSync(eventsPath(pane), JSON.stringify({ event: 'Stop', ts: nowSec() }) + '\n');
    expect(statusOf(name)).toBe('DONE');
    tm(['kill-session', '-t', name]);
  });

  test('a scraped on-screen [y/n] prompt is trusted over an idle hook', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    paintLiteral(pane, 'Do you want to proceed? [y/n]');
    expect(await waitForScreen(pane, '[y/n]')).toBe(true);
    expect(statusOf(name)).toBe('PERMIT');
    tm(['kill-session', '-t', name]);
  });
});

suite('control-mode transport and fork fallback (in-process)', () => {
  test('control client reads the same fused state as the fork path', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'permit' });

    const client = new TmuxControlClient();
    await client.connect();
    let controlRuns = 0;
    const controlRun = client.run.bind(client);
    client.run = (command: string) => {
      controlRuns++;
      return controlRun(command);
    };
    const latch = { dead: false };
    try {
      const states = await fullRefreshStatesTui(dirs, client, latch);
      const mine = states.find((s) => s.paneId === pane);
      expect(controlRuns).toBeGreaterThan(0); // list/capture used the control transport
      expect(latch.dead).toBe(false); // control read succeeded — no fallback
      expect(mine?.status).toBe(AgentStatus.PERMIT);
    } finally {
      await client.close();
    }
    tm(['kill-session', '-t', name]);
  });

  test('a dead control client flips the latch and falls back to the fork path', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'working' });

    const client = new TmuxControlClient();
    await client.connect();
    await client.close(); // now every control read throws
    const latch = { dead: false };

    const states = await fullRefreshStatesTui(dirs, client, latch);
    expect(latch.dead).toBe(true); // control error latched dead
    const mine = states.find((s) => s.paneId === pane);
    expect(mine?.status).toBe(AgentStatus.BUSY); // fork fallback still produced state
    tm(['kill-session', '-t', name]);
  });
});

suite('pane presence reconciliation (Present | Absent | Unknown)', () => {
  test('an Absent pane is swept while a Present pane is retained', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' }); // Present — live pane
    writeStatus('%9999', name, { state: 'idle' }); // Absent — pane never existed

    const r = fleet(['reconcile']);
    expect(r.code).toBe(0);
    expect(existsSync(statusPath(pane))).toBe(true); // Present retained
    expect(existsSync(statusPath('%9999'))).toBe(false); // Absent removed
    tm(['kill-session', '-t', name]);
  });

  test('a transient tmux failure (Unknown) never deletes state', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    writeStatus('%9999', name, { state: 'idle' }); // would be Absent if tmux answered

    // Point the binary at a socket that cannot answer: list-panes fails, so
    // every tracked pane is Unknown and the sweep must delete nothing.
    const r = fleet(['reconcile'], { TMUX: `${root}/does-not-exist.sock,0,0` });
    expect(r.code).toBe(0);
    expect(existsSync(statusPath(pane))).toBe(true);
    expect(existsSync(statusPath('%9999'))).toBe(true); // NOT deleted under uncertainty
    // Cleanup the orphan so it can't leak into later cases.
    rmSync(statusPath('%9999'), { force: true });
    tm(['kill-session', '-t', name]);
  });

  test('--dry-run reports but deletes nothing', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    writeStatus('%9998', name, { state: 'idle' });
    const r = fleet(['reconcile', '--dry-run']);
    expect(r.code).toBe(0);
    expect(existsSync(statusPath('%9998'))).toBe(true); // dry-run kept the orphan
  });

  test('a stale working record is rewritten atomically to idle', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'working', ts: nowSec() - 181 });
    const r = fleet(['reconcile']);
    expect(r.code).toBe(0);
    const updated = JSON.parse(readFileSync(statusPath(pane), 'utf-8')) as { state: string };
    expect(updated.state).toBe('idle');
  });

  test('a corrupt or incomplete record is retained for a later pass', () => {
    const path = statusPath('%9997');
    writeFileSync(path, '{"state":"working"');
    const r = fleet(['reconcile', '--verbose']);
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(r.stdout).toContain('corrupt or incomplete');
  });
});

suite('acknowledgement', () => {
  test('ack clears a DONE agent out of the attention tier', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'done' });
    expect(statusOf(name)).toBe('DONE');
    const r = fleet(['ack', pane]);
    expect(r.code).toBe(0);
    expect(statusOf(name)).toBe('IDLE'); // acknowledged -> no longer needs you
    tm(['kill-session', '-t', name]);
  });
});

suite('wait', () => {
  test('returns 0 once the target state is reached', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'done' });
    const r = fleet(['wait', name, '--state', 'ready', '--timeout', '5']);
    expect(r.code).toBe(0);
    tm(['kill-session', '-t', name]);
  });

  test('returns 124 on timeout when the state is never reached', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'working' });
    const r = fleet(['wait', name, '--state', 'ready', '--timeout', '1']);
    expect(r.code).toBe(124); // timeout(1) convention
    tm(['kill-session', '-t', name]);
  });

  test('returns 2 for an unknown session selector', () => {
    const r = fleet(['wait', 'no-such-session', '--state', 'ready', '--timeout', '1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('No agents found');
  });
});

suite('send', () => {
  test('delivers and executes a prompt for an idle agent (exit 0)', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    const r = fleet(['send', name, "printf 'fleet-%s\\n' executed"]);
    expect(r.code).toBe(0);
    // `fleet-executed` is absent from the typed command and only appears after
    // Enter executes it, so this proves both text delivery and submission.
    expect(await waitForScreen(pane, 'fleet-executed')).toBe(true);
  });

  test('refuses a busy agent unless forced (exit 1)', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'working' });
    const r = fleet(['send', name, 'hello']);
    expect(r.code).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('busy');
    tm(['kill-session', '-t', name]);
  });

  test('a busy agent can be explicitly overridden with --force', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'working' });
    const r = fleet(['send', name, "printf 'forced-%s\\n' delivery", '--force']);
    expect(r.code).toBe(0);
    expect(await waitForScreen(pane, 'forced-delivery')).toBe(true);
  });

  test('returns 1 for an unknown session', () => {
    const r = fleet(['send', 'no-such-session', 'hello']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No agents found');
  });
});

suite('approve (permit-key resolution + transport)', () => {
  test('resolves the agent-aware approve keys and delivers them to the pane', async () => {
    const { name, pane } = newSession();
    // A "Do you want to proceed?" dialog with no [y/n] resolves to claude's
    // menu default approve key ('1'), not a literal 'y'.
    paintLiteral(pane, 'Do you want to proceed?');
    expect(await waitForScreen(pane, 'proceed?')).toBe(true);

    const keys = resolvePermitKeys(pane, 'claude', 'approve');
    expect(keys).toEqual(['1']);

    sendKeyNames(pane, keys); // real send-keys against the private server
    expect(await waitForScreen(pane, 'proceed?1')).toBe(true);
    tm(['kill-session', '-t', name]);
  });

  test('scrape confirms the same pane reads PERMIT for the whole loop', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    paintLiteral(pane, 'Do you want to proceed?');
    // Fork-path fusion sees the on-screen prompt and reports PERMIT.
    const states = fullRefreshStates(dirs);
    expect(states.find((s) => s.paneId === pane)?.status).toBe(AgentStatus.PERMIT);
    tm(['kill-session', '-t', name]);
  });
});

suite('observability JSON (compiled binary)', () => {
  test('list --json emits the versioned envelope with the live agent', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'permit' });
    const r = fleet(['list', '--json']);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.schema).toBe('fleet.observe/v1');
    expect(env.outcome).toBe('ok');
    const mine = env.agents.find((a: { pane: string }) => a.pane === pane);
    expect(mine?.status).toBe('PERMIT');
    expect(mine?.session).toBe(name);
    tm(['kill-session', '-t', name]);
  });

  test('status --json <pane-selector> narrows to exactly that pane', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'done' });
    const r = fleet(['status', '--json', pane]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.selector).toBe(pane);
    expect(env.count).toBe(1);
    expect(env.agents[0].pane).toBe(pane);
    expect(env.agents[0].status).toBe('DONE');
    tm(['kill-session', '-t', name]);
  });

  test('status --json with a no-match selector → no_match, exit 2', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    const r = fleet(['status', '--json', '%999999']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).outcome).toBe('no_match');
    tm(['kill-session', '-t', name]);
  });

  test('status --json distinguishes a cached snapshot from tmux unavailable', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'done' });
    const state = fullRefreshStates(dirs).find((candidate) => candidate.paneId === pane)!;
    const liveEnv = process.env.TMUX;
    const staleEnv = `${join(root, 'unreachable.sock')},0,0`;
    process.env.TMUX = staleEnv;
    __resetSnapshotCacheForTests();
    writeAgentSnapshot([state]);
    const cachePath = snapshotCacheFilePath();
    process.env.TMUX = liveEnv;

    const r = fleet(['status', '--json', pane], { TMUX: staleEnv });
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.outcome).toBe('stale_data');
    expect(env.agents[0].pane).toBe(pane);
    rmSync(cachePath, { force: true });
  });
});

suite('wait multi-target (compiled binary)', () => {
  test('--any returns 0 when ONE of two selectors is already satisfied', () => {
    const a = newSession();
    const b = newSession();
    writeStatus(a.pane, a.name, { state: 'working' }); // not ready
    writeStatus(b.pane, b.name, { state: 'done' }); // ready
    const r = fleet(['wait', a.name, b.name, '--state', 'ready', '--any', '--timeout', '5']);
    expect(r.code).toBe(0);
    tm(['kill-session', '-t', a.name]);
    tm(['kill-session', '-t', b.name]);
  });

  test('default (ALL) times out when only one of two selectors is satisfied', () => {
    const a = newSession();
    const b = newSession();
    writeStatus(a.pane, a.name, { state: 'working' });
    writeStatus(b.pane, b.name, { state: 'done' });
    const r = fleet(['wait', a.name, b.name, '--state', 'ready', '--timeout', '1']);
    expect(r.code).toBe(124);
    tm(['kill-session', '-t', a.name]);
    tm(['kill-session', '-t', b.name]);
  });
});

suite('capture (compiled binary)', () => {
  test('captures a pane buffer as plain text (read-only)', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    paintLiteral(pane, 'CAPTURE-MARKER-123');
    expect(await waitForScreen(pane, 'CAPTURE-MARKER-123')).toBe(true);
    const r = fleet(['capture', '--pane', pane, '--lines', '50']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('CAPTURE-MARKER-123');
    // Read-only: the status file is untouched.
    expect(JSON.parse(readFileSync(statusPath(pane), 'utf-8')).state).toBe('idle');
    tm(['kill-session', '-t', name]);
  });

  test('--json wraps the buffer, and a no-match selector exits 2', () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'idle' });
    paintLiteral(pane, 'JSONCAP');
    const ok = fleet(['capture', '--pane', pane, '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).pane).toBe(pane);
    const miss = fleet(['capture', '--pane', '%999999']);
    expect(miss.code).toBe(2);
    expect(miss.stderr).toContain('No pane matched');
    tm(['kill-session', '-t', name]);
  });
});

suite('watch (compiled binary, bounded subprocess)', () => {
  test('emits an initial snapshot then terminates cleanly on SIGTERM', async () => {
    const { name, pane } = newSession();
    writeStatus(pane, name, { state: 'permit' });

    const proc = Bun.spawn({
      cmd: [BIN, 'watch', name],
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMUX: tmuxEnv, TMUX_TMPDIR: root, XDG_CONFIG_HOME: configDir },
    });

    // Read the first (snapshot) line, then tear the process down.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let firstLine = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const nl = buffered.indexOf('\n');
      if (nl >= 0) {
        firstLine = buffered.slice(0, nl);
        break;
      }
    }
    await reader.cancel().catch(() => {});

    proc.kill('SIGTERM');
    const code = await proc.exited;

    const snap = JSON.parse(firstLine);
    expect(snap.type).toBe('snapshot');
    expect(snap.schema).toBe('fleet.observe/v1');
    expect(snap.agents.some((a: { pane: string }) => a.pane === pane)).toBe(true);
    // Clean shutdown: exit 0 (the SIGTERM handler flips the stop flag and the
    // loop returns) or the signal's 143 — never a crash.
    expect(code === 0 || code === 143).toBe(true);

    tm(['kill-session', '-t', name]);
  });
});
