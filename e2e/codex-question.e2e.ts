// Private tmux exercises Fleet's queued-question routing. Real Codex's form
// and tool-result delivery are covered separately by codex-question.py.
import { afterEach, beforeEach, expect, test as bunTest } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bin = process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet');
// The synthetic process uses Linux prctl to appear in normal Codex discovery.
// The native fixture can be run separately on other supported platforms.
const available =
  process.platform === 'linux' &&
  existsSync(bin) &&
  ['tmux', 'python3'].every(
    (name) => Bun.spawnSync(['which', name], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0,
  );
const test = available ? bunTest : bunTest.skip;
let root: string;
let socket: string;
let env: typeof process.env;
let pane: string;

function tm(...args: string[]): string {
  const p = Bun.spawnSync(['tmux', '-S', socket, '-f', '/dev/null', ...args], { env });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trimEnd();
}
const capture = (target = 'monitor') => tm('capture-pane', '-p', '-t', target);
const received = (name = 'agent') => readFileSync(join(root, name + '.keys'), 'utf8').trim();
async function waitFor(check: () => boolean, timeoutMs = 6000, target = 'monitor'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await Bun.sleep(30);
  }
  throw new Error('Timed out waiting for fixture\n' + capture(target));
}
function launchAgent(name: string): void {
  writeFileSync(join(root, name + '.keys'), '');
  tm(
    'new-session',
    '-d',
    '-s',
    name,
    '-x',
    '120',
    '-y',
    '36',
    'python3',
    join(root, 'question.py'),
    join(root, name + '.keys'),
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fleet-question-'));
  socket = join(root, 'tmux.sock');
  env = {
    ...process.env,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    FLEET_THEME: 'dark',
    TMUX: '',
  };
  mkdirSync(join(root, 'config/fleet'), { recursive: true });
  mkdirSync(join(root, 'status'));
  writeFileSync(
    join(root, 'config/fleet/agents.json'),
    JSON.stringify({
      agents: [{ name: 'codex', statusDir: join(root, 'status') }],
    }),
  );
  writeFileSync(
    join(root, 'question.py'),
    `import ctypes,os,pathlib,signal,sys,tty
ctypes.CDLL(None).prctl(15,b"codex",0,0,0)
tty.setraw(0)
path=pathlib.Path(sys.argv[1])
def screen(text):
 os.write(1, ('\\x1b[2J\\x1b[H'+text.replace('\\n','\\r\\n')).encode())
screen('• Queued follow-up inputs\\n  ? 1 question\\n    shift + ← to answer')
signal.signal(signal.SIGUSR1, lambda *_: screen('Working…'))
signal.signal(signal.SIGUSR2, lambda *_: screen('• Queued follow-up inputs\\n  ? 1 question\\n    shift + ← to answer'))
signal.signal(signal.SIGHUP, lambda *_: screen('Allow command?\\npress enter to confirm or esc to cancel'))
signal.signal(signal.SIGALRM, lambda *_: screen('• Working (2m 00s • esc to interrupt)\\n\\n• Queued follow-up inputs\\n  ? 1 question · 5s\\n    shift + ← to answer'))
signal.signal(signal.SIGVTALRM, lambda *_: compact_queue())
pending=b''
selected=0
opened=False
compact=False
def compact_queue():
 global compact
 compact=True
 screen('• Working (7m 38s • esc to interrupt)\\n\\n• Queued follow-up inputs\\n  ? 2 questions · 5s\\n    shift+← to answer')
def form():
 choices='\\n'.join(('› ' if i==selected else '  ')+f'{i+1}. {name}' for i,name in enumerate(['Red','Blue']))
 footer='enter submit   ctrl+] skip   alt+↓ main prompt   shift+← next question' if compact else 'enter submit   ctrl + ] skip   alt + ↓ main prompt'
 screen('• Queued follow-up inputs\\n\\nWhich fixture colour?\\n'+choices+'\\n  '+footer)
keys=[b'\\x1b[1;2D',b'\\x1b[B',b'\\x1b[A',b'\\r',b'\\x1d']
while True:
 data=os.read(0,4096)
 with path.open('a') as out:out.write(data.hex())
 pending+=data
 while pending:
  key=next((key for key in keys if pending.startswith(key)),None)
  if key is None:
   if any(key.startswith(pending) for key in keys):break
   pending=pending[1:]
   continue
  pending=pending[len(key):]
  if key==keys[0]:
   opened=True
   form()
  elif opened:
   if key==keys[1]:selected=min(1,selected+1)
   elif key==keys[2]:selected=max(0,selected-1)
   elif key in keys[3:]:
    result=['Red','Blue'][selected]+' accepted' if key==keys[3] else 'Question skipped'
    screen(result+'\\n› Ask Codex to do anything')
    opened=False
    continue
   form()
`,
  );
  const fixtureCheck = Bun.spawnSync(['python3', '-m', 'py_compile', join(root, 'question.py')]);
  if (fixtureCheck.exitCode) throw new Error(fixtureCheck.stderr.toString());
  launchAgent('agent');
  // prctl names the fixture "codex" before drawing. If Fleet's first process
  // scan races Python startup it cannot discover the agent until the next
  // slow tick, which can exceed Bun's default hook timeout under CPU load.
  await waitFor(() => capture('agent').includes('shift + ← to answer'), 6000, 'agent');
  env.TMUX = `${socket},${tm('display-message', '-p', '#{pid}')},0`;
  pane = tm('display-message', '-p', '-t', 'agent', '#{pane_id}');
  tm('new-session', '-d', '-s', 'monitor', '-x', '140', '-y', '40', bin);
  await waitFor(() => capture().includes('[s] answer'), 12_000);
}, 20_000);

afterEach(() => {
  Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { env });
  rmSync(root, { recursive: true, force: true });
});

test('S opens queued questions, preserves Escape, and keeps Fleet alive after answering', async () => {
  const pid = tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}');
  // A coalesced trailing q must not be interpreted as quit after opening.
  tm('send-keys', '-t', 'monitor', '-l', 'sq');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Escape');
  await waitFor(() => !capture().includes('● ANSWER'));
  expect(received()).toBe('1b5b313b3244');
  expect(capture('agent')).toContain('enter submit');
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Down');
  await waitFor(() => capture().includes('› 2. Blue'));
  expect(capture('agent')).toContain('› 2. Blue');
  tm('send-keys', '-t', 'monitor', 'Up');
  await waitFor(() => capture().includes('› 1. Red'));
  tm('send-keys', '-t', 'monitor', 'Down', 'Enter');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Blue accepted');
  const after = received();
  expect(after).toBe('1b5b313b32441b5b421b5b411b5b420d');
  expect(capture()).not.toContain('● LIVE');
  tm('send-keys', '-t', 'monitor', 'Down');
  await Bun.sleep(100);
  expect(received()).toBe(after);
  expect(tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}')).toBe(pid);
  expect(tm('display-message', '-p', '-t', 'monitor', '#{pane_dead}')).toBe('0');
}, 12000);

test('Ctrl-] skips the last question and returns to Fleet without entering the conversation', async () => {
  const pid = tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}');
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  tm('send-keys', '-t', 'monitor', 'C-]');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Question skipped');
  expect(capture()).not.toContain('● LIVE');
  const after = received();
  expect(after).toBe('1b5b313b32441d');
  tm('send-keys', '-t', 'monitor', 'Down');
  await Bun.sleep(100);
  expect(received()).toBe(after);
  expect(tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}')).toBe(pid);
  expect(tm('display-message', '-p', '-t', 'monitor', '#{pane_dead}')).toBe('0');
}, 12000);

test('compact Codex shortcuts open and reopen an async question without submitting on Escape', async () => {
  process.kill(Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}')), 'SIGVTALRM');
  tm('select-pane', '-t', pane, '-T', '[ ! ] Action Required | Codex');
  await waitFor(() => capture('agent').includes('shift+← to answer'));
  await waitFor(() => capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('ctrl+] skip'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Escape');
  await waitFor(() => !capture().includes('● ANSWER'));
  expect(received()).toBe('1b5b313b3244');
  expect(capture('agent')).toContain('ctrl+] skip');
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('ctrl+] skip'));
  expect(received()).toBe('1b5b313b3244');
  expect(capture()).not.toContain('Cannot send:');
  tm('send-keys', '-t', 'monitor', 'Down', 'Enter');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Blue accepted');
  expect(received()).toBe('1b5b313b32441b5b420d');
}, 15000);

test('S checks the live question when its cached row still says permission', async () => {
  const agentPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  const monitorPid = Number(tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}'));
  process.kill(agentPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Action Required | Codex');
  await waitFor(() => capture().includes('approve') && !capture().includes('[s] answer'));
  // Pin the dashboard between observations, then queue S before resuming it.
  // The real agent has drawn its question, but Fleet still holds PERMIT.
  process.kill(monitorPid, 'SIGSTOP');
  try {
    process.kill(agentPid, 'SIGUSR2');
    await waitFor(() => capture('agent').includes('shift + ← to answer'));
    tm('send-keys', '-t', 'monitor', 's');
  } finally {
    process.kill(monitorPid, 'SIGCONT');
  }
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Down', 'Enter');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Blue accepted');
}, 18000);

test('an aged queued question refines the permission title and opens with S', async () => {
  process.kill(Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}')), 'SIGALRM');
  tm('select-pane', '-t', pane, '-T', 'Action Required | Codex');
  await waitFor(() => capture('agent').includes('? 1 question · 5s'));
  await waitFor(() => capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Down', 'Enter');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Blue accepted');
  expect(capture()).not.toContain('Cannot send:');
}, 15000);

test('S leaves a genuine permission dialog untouched', async () => {
  process.kill(Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}')), 'SIGHUP');
  tm('select-pane', '-t', pane, '-T', 'Action Required | Codex');
  await waitFor(() => capture().includes('approve') && !capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('Cannot send: Agent has a permission prompt'));
  expect(capture()).not.toContain('● ANSWER');
  expect(received()).toBe('');
  expect(capture('agent')).toContain('press enter to confirm or esc to cancel');
}, 12000);

test('a question drawn after S replaces the blocked send view without reopening Fleet', async () => {
  const agentPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  const monitorPid = tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}');
  process.kill(agentPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Action Required | Codex');
  await waitFor(() => capture().includes('approve') && !capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('Cannot send: Agent has a permission prompt'));
  expect(received()).toBe('');
  // Codex's attention title can precede the question frame. SEND must keep
  // watching the exact target after its first question check finds nothing.
  process.kill(agentPid, 'SIGUSR2');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Down', 'Enter');
  await waitFor(() => !capture().includes('● ANSWER') && capture().includes('[↑↓] nav'));
  expect(capture('agent')).toContain('Blue accepted');
  expect(capture()).not.toContain('Cannot send:');
  expect(tm('display-message', '-p', '-t', 'monitor', '#{pane_pid}')).toBe(monitorPid);
}, 18000);

test('a ready SEND target that becomes permission-blocked still opens its arriving question', async () => {
  const agentPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  process.kill(agentPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Ready | Codex');
  await waitFor(() => capture().includes('send prompt') && !capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('Type your prompt, Enter to send'));
  expect(received()).toBe('');
  // A hook-file refresh can update SEND while its empty composer is open.
  // The watcher must also follow a target that was initially ready.
  tm('select-pane', '-t', pane, '-T', 'Action Required | Codex');
  writeFileSync(
    join(root, 'status', pane.slice(1) + '.status'),
    JSON.stringify({
      pane,
      session: 'agent',
      state: 'working',
      tool: '',
      ts: Math.floor(Date.now() / 1000),
      tmux_pid: 0,
    }),
  );
  await waitFor(() => capture().includes('Cannot send: Agent has a permission prompt'));
  process.kill(agentPid, 'SIGUSR2');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  expect(received()).toBe('1b5b313b3244');
  tm('send-keys', '-t', 'monitor', 'Escape');
  await waitFor(() => !capture().includes('● ANSWER'));
  expect(received()).toBe('1b5b313b3244');
  expect(capture('agent')).toContain('enter submit');
}, 20000);

test('a disappearing target never redirects an answer to another question', async () => {
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('● ANSWER') && capture().includes('Which fixture colour?'));
  tm('kill-pane', '-t', pane);
  launchAgent('other');
  tm('send-keys', '-t', 'monitor', '-l', '1');
  await waitFor(() => !capture().includes('● ANSWER'));
  expect(received('other')).toBe('');
}, 12000);

test('an arriving question leaves a typed draft intact and blocks sending it', async () => {
  const agentPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  process.kill(agentPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Ready | Codex');
  await waitFor(() => capture().includes('send prompt') && !capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('Type your prompt, Enter to send'));
  tm('send-keys', '-t', 'monitor', '-l', 'unfinished draft');
  await waitFor(() => capture().includes('unfinished draft'));
  process.kill(agentPid, 'SIGUSR2');
  await waitFor(() => capture().includes('Cannot send: Agent is asking a question'));
  expect(capture()).not.toContain('● ANSWER');
  expect(capture()).toContain('unfinished draft');
  expect(received()).toBe('');
  tm('send-keys', '-t', 'monitor', 'Enter');
  await Bun.sleep(100);
  expect(capture()).toContain('unfinished draft');
  expect(received()).toBe('');
  process.kill(agentPid, 'SIGUSR1');
  await waitFor(() => capture().includes('Type your prompt, Enter to send') && capture().includes('unfinished draft'));
  tm('send-keys', '-t', 'monitor', 'Escape');
  await waitFor(() => !capture().includes('Send to'));
  expect(received()).toBe('');
}, 22000);

test('a replacement process in the same pane never receives an existing draft', async () => {
  const originalPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  process.kill(originalPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Ready | Codex');
  await waitFor(() => capture().includes('send prompt') && !capture().includes('[s] answer'));
  tm('send-keys', '-t', 'monitor', 's');
  await waitFor(() => capture().includes('Type your prompt, Enter to send'));
  tm('send-keys', '-t', 'monitor', '-l', 'draft for the original process');
  await waitFor(() => capture().includes('draft for the original process'));

  const replacementKeys = join(root, 'replacement.keys');
  writeFileSync(replacementKeys, '');
  tm('respawn-pane', '-k', '-t', pane, 'python3', join(root, 'question.py'), replacementKeys);
  await waitFor(() => capture('agent').includes('shift + ← to answer'));
  const replacementPid = Number(tm('display-message', '-p', '-t', pane, '#{pane_pid}'));
  expect(replacementPid).not.toBe(originalPid);
  process.kill(replacementPid, 'SIGUSR1');
  tm('select-pane', '-t', pane, '-T', 'Ready | Codex');
  await waitFor(() => capture('agent').includes('Working…'));
  await waitFor(() => capture().includes(`Target ${pane} disappeared or changed`));
  expect(capture()).toContain('draft for the original process');
  expect(received('replacement')).toBe('');
  tm('send-keys', '-t', 'monitor', 'Enter');
  await Bun.sleep(300);
  expect(received('replacement')).toBe('');
  expect(capture()).toContain(`Target ${pane} disappeared or changed`);
  expect(capture()).toContain('draft for the original process');
  tm('send-keys', '-t', 'monitor', 'Enter');
  await Bun.sleep(100);
  expect(received('replacement')).toBe('');
  tm('send-keys', '-t', 'monitor', 'Escape');
  await waitFor(() => !capture().includes('Send to'));
}, 15000);
