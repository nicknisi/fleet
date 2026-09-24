// Real private-tmux regression: no model runs and no live agent receives input.
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('unhooked Codex idle decorations do not read as working', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-codex-idle-'));
  const socket = join(root, 'tmux.sock');
  const bin = process.env.FLEET_TEST_BIN ?? join(import.meta.dir, '../dist/fleet');
  const env = { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), TMUX: '' };
  function tm(...args: string[]): string {
    const p = Bun.spawnSync(['tmux', '-S', socket, ...args], { env });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trimEnd();
  }
  async function screen(text: string): Promise<void> {
    writeFileSync(join(root, 'screen.txt'), text);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (tm('capture-pane', '-p', '-t', 'agent').includes(text.split('\n')[0]!)) return;
      await Bun.sleep(25);
    }
    throw new Error('Fixture did not repaint');
  }
  function status(): string {
    const p = Bun.spawnSync([bin, 'status', '--json', 'agent'], { env });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString()).agents[0].status;
  }
  mkdirSync(join(root, 'config/fleet'), { recursive: true });
  writeFileSync(join(root, 'config/fleet/agents.json'), '{"agents":[]}');
  writeFileSync(join(root, 'screen.txt'), 'initial');
  // Match the process-discovery comm without launching Codex or a model.
  writeFileSync(
    join(root, 'screen.py'),
    'import ctypes,pathlib,sys,time\n' +
      'ctypes.CDLL(None).prctl(15,b"codex",0,0,0)\n' +
      'last=None\nwhile True:\n text=pathlib.Path(sys.argv[1]).read_text()\n' +
      ' if text!=last:\n  print("\\x1b[2J\\x1b[H"+text,end="",flush=True)\n  last=text\n time.sleep(.02)\n',
  );
  try {
    tm(
      'new-session',
      '-d',
      '-s',
      'agent',
      '-x',
      '120',
      '-y',
      '36',
      'python3',
      join(root, 'screen.py'),
      join(root, 'screen.txt'),
    );
    env.TMUX = `${socket},${tm('display-message', '-p', '#{pid}')},0`;
    tm('select-pane', '-t', 'agent', '-T', 'Codex');
    // Codex's idle composer, particles included, as captured from Codex 0.154.
    const composer = '\n    ⠄       ⢀        ⠐\n›⠁Ask Codex to do anything    ⠈  ⠂\n  ⠠       ⢀';
    await screen('Completed the task.' + composer);
    expect(status()).toBe('IDLE');
    await screen('• Working (2m 01s • esc to interrupt)' + composer);
    expect(status()).toBe('BUSY');
    await screen('Completed the second task.' + composer);
    tm('select-pane', '-t', 'agent', '-T', '⠋ Working');
    expect(status()).toBe('BUSY');
    tm('select-pane', '-t', 'agent', '-T', 'Codex');
    expect(status()).toBe('IDLE');
    await screen('press enter to confirm or esc to cancel' + composer);
    expect(status()).toBe('PERMIT');
  } finally {
    Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], { env });
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
