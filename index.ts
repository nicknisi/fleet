import packageJson from './package.json' with { type: 'json' };
import { TuiApp, TuiMode } from './src/tui/app.ts';
import { render } from './src/tui/render.ts';
import { canSendTo } from './src/tui/send.ts';
import { parseKeyEvent } from './src/terminal/input.ts';
import { isMouseSequence } from './src/terminal/mouse.ts';
import {
  enterAlternateScreen,
  hideCursor,
  enterRawMode,
  enableMouse,
  restore,
  getTerminalSize,
} from './src/terminal/terminal.ts';
import { fuseState } from './src/state/engine.ts';
import { readAllStatusDirs, watchStatusDirs } from './src/state/hooks.ts';
import { readLastEvent, deriveStatusFromLastEvent } from './src/state/events.ts';
import { scrapePane } from './src/state/scraper.ts';
import { AgentStatus, type AgentState } from './src/state/types.ts';
import { AgentRegistry } from './src/agents/registry.ts';
import { listPanes, switchClient, gitBranch } from './src/tmux/sessions.ts';
import { detectPorts } from './src/tmux/ports.ts';
import { sendKeys, sendRawKey } from './src/tmux/send.ts';
import { runStatus } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { runSend } from './src/cli/send.ts';
import { runInstall, runUninstall } from './src/cli/install.ts';
import { runDoctor } from './src/cli/doctor.ts';
import { runReconcile } from './src/cli/reconcile.ts';
import { join } from 'node:path';

const VERSION: string = packageJson.version;
const FAST_REFRESH_MS = 500;
const SLOW_REFRESH_MS = 5000;

function printVersion(): number {
  process.stdout.write(`fleet ${VERSION}\n`);
  return 0;
}

function printHelp(): number {
  process.stdout.write(
    [
      'fleet — agent dashboard TUI',
      '',
      'Usage:',
      '  fleet [--preview|--no-preview]  Launch TUI dashboard',
      '  fleet status [--tmux] <session> Query agent state',
      '  fleet next                     Jump to next waiting agent',
      '  fleet send <session> <prompt>  Send prompt to session',
      '  fleet install                  Register as Claude Code plugin',
      '  fleet uninstall                Remove plugin registration',
      '  fleet doctor                   Health check',
      '  fleet reconcile [--dry-run]    Sweep orphan status files',
      '  fleet --version, -v            Print version',
      '  fleet --help, -h               Show this help',
      '',
    ].join('\n'),
  );
  return 0;
}

function shortenPath(path: string): string {
  const home = Bun.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

// Slow caches (git branches, ports, scrape) — refreshed every SLOW_REFRESH_MS
const branchCache = new Map<string, string | null>();
let portCache = new Map<string, number[]>();
const scrapeCache = new Map<string, AgentStatus | null>();

function refreshSlowCaches(panes: { paneId: string; currentPath: string }[]): void {
  const paths = new Set<string>();
  for (const p of panes) paths.add(p.currentPath);
  branchCache.clear();
  for (const path of paths) {
    branchCache.set(path, gitBranch(path));
  }

  const newPorts = new Map<string, number[]>();
  try {
    for (const pp of detectPorts()) {
      const existing = newPorts.get(pp.paneId) ?? [];
      existing.push(pp.port);
      newPorts.set(pp.paneId, existing);
    }
  } catch {}
  portCache = newPorts;

  // Layer 3: pane scraping (~50ms per pane) — slow cycle only
  const seen = new Set<string>();
  for (const p of panes) {
    seen.add(p.paneId);
    scrapeCache.set(p.paneId, scrapePane(p.paneId));
  }
  for (const paneId of scrapeCache.keys()) {
    if (!seen.has(paneId)) scrapeCache.delete(paneId);
  }
}

// Fast refresh: ONE tmux call + status file reads + last-line JSONL reads. No git, no lsof.
function refreshStates(statusDirs: string[]): AgentState[] {
  const hookStatuses = readAllStatusDirs(statusDirs);
  const panes = listPanes();

  const hookByPane = new Map<string, (typeof hookStatuses)[number]>();
  for (const h of hookStatuses) {
    hookByPane.set(h.pane, h);
  }

  const states: AgentState[] = [];

  for (const pane of panes) {
    const hook = hookByPane.get(pane.paneId);

    let status: AgentStatus;
    let tool: string | null = null;
    let ts = Math.floor(Date.now() / 1000);

    if (hook) {
      let eventStatus: AgentStatus | null = null;
      for (const dir of statusDirs) {
        const eventsFile = join(dir, `${pane.paneNum}.events.jsonl`);
        const lastEvent = readLastEvent(eventsFile);
        if (lastEvent) {
          eventStatus = deriveStatusFromLastEvent(lastEvent);
          break;
        }
      }

      tool = hook.tool || null;
      ts = hook.ts;

      status = fuseState({
        hookState: hook.state,
        hookTs: hook.ts,
        eventStatus,
        scrapeStatus: scrapeCache.get(pane.paneId) ?? null,
        currentStatus: AgentStatus.IDLE,
        currentTs: 0,
      });
    } else {
      status = AgentStatus.SHELL;
    }

    states.push({
      paneId: pane.paneId,
      paneNum: pane.paneNum,
      session: pane.sessionName,
      status,
      tool,
      project: shortenPath(pane.currentPath),
      branch: branchCache.get(pane.currentPath) ?? null,
      ports: portCache.get(pane.paneId) ?? [],
      ts,
      agentType: 'claude',
    });
  }

  return states;
}

// Full refresh: runs slow caches then fast refresh
function fullRefreshStates(statusDirs: string[]): AgentState[] {
  const panes = listPanes();
  refreshSlowCaches(panes);
  return refreshStates(statusDirs);
}

function handleCli(args: string[]): number | null {
  if (args.includes('--version') || args.includes('-v')) return printVersion();
  if (args.includes('--help') || args.includes('-h')) return printHelp();

  const command = args[0];
  if (!command) return null;

  const registry = new AgentRegistry();
  const statusDirs = registry.statusDirs();

  switch (command) {
    case 'status': {
      const states = fullRefreshStates(statusDirs);
      const output = runStatus(args.slice(1), states);
      if (output.length > 0) process.stdout.write(output + '\n');
      return 0;
    }
    case 'next': {
      const states = fullRefreshStates(statusDirs);
      return runNext(states);
    }
    case 'send': {
      const session = args[1];
      const prompt = args
        .slice(2)
        .filter((a) => !a.startsWith('--'))
        .join(' ');
      if (!session || !prompt) {
        process.stderr.write('Usage: fleet send <session> <prompt>\n');
        return 1;
      }
      const states = fullRefreshStates(statusDirs);
      const force = args.includes('--force');
      return runSend(session, prompt, states, force);
    }
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'doctor':
      return runDoctor();
    case 'reconcile': {
      const dryRun = args.includes('--dry-run');
      const verbose = args.includes('--verbose');
      return runReconcile(dryRun, verbose);
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      return 1;
  }
}

function handleFilterInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>, finish: (code: number) => void): void {
  switch (key.type) {
    case 'escape':
      app.clearFilter();
      break;
    case 'backspace': {
      const f = app.getFilter();
      if (f.length > 0) {
        app.setFilter(f.slice(0, -1));
      } else {
        app.clearFilter();
      }
      break;
    }
    case 'char':
      app.setFilter(app.getFilter() + key.char);
      break;
    case 'arrow':
      if (key.direction === 'up') app.moveUp();
      if (key.direction === 'down') app.moveDown();
      break;
    case 'enter': {
      const selected = app.selectedState();
      if (selected) {
        finish(0);
        switchClient(selected.paneId);
      }
      break;
    }
  }
}

function handleSendInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>, _finish: (code: number) => void): void {
  switch (key.type) {
    case 'escape':
      app.exitSend();
      break;
    case 'backspace':
      app.sendBuffer = app.sendBuffer.slice(0, -1);
      break;
    case 'char':
      app.sendBuffer += key.char;
      break;
    case 'enter': {
      const selected = app.selectedState();
      if (selected && app.sendBuffer.length > 0) {
        const check = canSendTo(selected);
        if (check.ok) {
          try {
            sendKeys(selected.paneId, app.sendBuffer);
          } catch {
            // Silently fail
          }
        }
      }
      app.exitSend();
      break;
    }
  }
}

function handlePassthroughInput(app: TuiApp, buf: Buffer): void {
  const selected = app.selectedState();
  if (!selected) {
    app.exitPassthrough();
    return;
  }

  const first = buf[0];
  if (first === 0x1b && buf.length === 1) {
    app.exitPassthrough();
    return;
  }

  try {
    sendRawKey(selected.paneId, buf);
  } catch {
    // Silently fail — pane may have closed
  }
}

async function launchTui(): Promise<number> {
  const registry = new AgentRegistry();
  const statusDirs = registry.statusDirs();
  const app = new TuiApp();

  const args = process.argv.slice(2);
  const size = getTerminalSize();
  if (args.includes('--no-preview')) {
    app.mode = TuiMode.DASHBOARD;
  } else if (args.includes('--preview') || size.cols >= 120) {
    app.mode = TuiMode.PREVIEW;
  }

  enterAlternateScreen();
  hideCursor();
  enterRawMode();
  enableMouse();

  let needsRender = true;

  const draw = () => {
    const size = getTerminalSize();
    process.stdout.write(render(app, size));
  };

  const doRefresh = () => {
    const states = refreshStates(statusDirs);
    app.updateStates(states);
    needsRender = true;
  };

  const doFullRefresh = () => {
    const states = fullRefreshStates(statusDirs);
    app.updateStates(states);
    needsRender = true;
  };

  doFullRefresh();

  // Debounce watcher-triggered refreshes — hooks fire rapidly
  let watcherTimeout: ReturnType<typeof setTimeout> | null = null;
  const stopWatching = watchStatusDirs(statusDirs, () => {
    if (watcherTimeout !== null) return;
    watcherTimeout = setTimeout(() => {
      watcherTimeout = null;
      doRefresh();
      draw();
    }, 100);
  });

  return await new Promise<number>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (code: number) => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      clearInterval(slowTimer);
      if (watcherTimeout !== null) clearTimeout(watcherTimeout);
      stopWatching();
      process.stdin.removeAllListeners('data');
      restore();
      resolve(code);
    };

    const tick = () => {
      if (needsRender) {
        draw();
        needsRender = false;
      }
      if (app.shouldQuit) finish(0);
    };

    const handleInput = (buf: Buffer) => {
      if (isMouseSequence(buf)) return;

      // Passthrough mode — forward raw bytes, only Esc and Ctrl-C escape
      if (app.mode === TuiMode.PASSTHROUGH) {
        const first = buf[0];
        if (first === 0x03) {
          app.shouldQuit = true;
          needsRender = true;
          return;
        }
        handlePassthroughInput(app, buf);
        needsRender = true;
        return;
      }

      const key = parseKeyEvent(buf);

      if (key.type === 'ctrl' && key.char === 'c') {
        app.shouldQuit = true;
        return;
      }

      if (app.mode === TuiMode.HELP) {
        app.mode = TuiMode.DASHBOARD;
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.SEND) {
        handleSendInput(app, key, finish);
        needsRender = true;
        return;
      }

      // Filter mode
      if (app.isFiltering()) {
        handleFilterInput(app, key, finish);
        needsRender = true;
        return;
      }

      switch (key.type) {
        case 'escape':
          app.shouldQuit = true;
          break;
        case 'char':
          switch (key.char) {
            case 'q':
              app.shouldQuit = true;
              break;
            case 'j':
              app.moveDown();
              break;
            case 'k':
              app.moveUp();
              break;
            case 'p':
              app.mode = app.mode === TuiMode.PREVIEW ? TuiMode.DASHBOARD : TuiMode.PREVIEW;
              break;
            case 'i':
              if (app.mode === TuiMode.PREVIEW && app.selectedState()) {
                app.enterPassthrough();
              }
              break;
            case 'y':
              if (app.mode === TuiMode.PREVIEW) {
                const sel = app.selectedState();
                if (sel && sel.status === AgentStatus.PERMIT) {
                  try {
                    sendRawKey(sel.paneId, Buffer.from('y'));
                  } catch {}
                }
              }
              break;
            case 'n':
              if (app.mode === TuiMode.PREVIEW) {
                const sel = app.selectedState();
                if (sel && sel.status === AgentStatus.PERMIT) {
                  try {
                    sendRawKey(sel.paneId, Buffer.from('n'));
                  } catch {}
                  break;
                }
              }
              {
                const states = fullRefreshStates(statusDirs);
                runNext(states);
                finish(0);
                return;
              }
            case 's': {
              const selected = app.selectedState();
              if (selected && canSendTo(selected).ok) {
                app.enterSend();
              } else {
                const visible = app.visibleStates();
                const sendableIdx = visible.findIndex((s) => canSendTo(s).ok);
                if (sendableIdx >= 0) {
                  app.selectedIndex = sendableIdx;
                  app.enterSend();
                }
              }
              break;
            }
            case '?':
              app.mode = TuiMode.HELP;
              break;
            case '/':
              app.setFilter('');
              break;
          }
          break;
        case 'enter': {
          const selected = app.selectedState();
          if (selected) {
            finish(0);
            switchClient(selected.paneId);
            return;
          }
          break;
        }
        case 'arrow':
          if (key.direction === 'up') app.moveUp();
          if (key.direction === 'down') app.moveDown();
          break;
      }
      needsRender = true;
    };

    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      handleInput(buf);
      tick();
    });

    process.stdout.on('resize', () => {
      needsRender = true;
      tick();
    });

    process.on('SIGWINCH', () => {
      needsRender = true;
      tick();
    });

    const isTyping = () => app.mode === TuiMode.SEND || app.isFiltering();

    // Fast timer: keep running in passthrough (preview needs live updates), skip during typing
    refreshTimer = setInterval(() => {
      if (isTyping()) return;
      doRefresh();
      tick();
    }, FAST_REFRESH_MS);

    // Slow timer: skip if user is actively typing
    const slowTimer = setInterval(() => {
      if (isTyping()) return;
      doFullRefresh();
      tick();
    }, SLOW_REFRESH_MS);

    tick();
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cliResult = handleCli(args);
  if (cliResult !== null) return cliResult;
  return launchTui();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    restore();
    console.error(err);
    process.exit(1);
  });
