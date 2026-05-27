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
import { readEventLog, deriveStatusFromEvents } from './src/state/events.ts';
import { AgentStatus, type AgentState } from './src/state/types.ts';
import { AgentRegistry } from './src/agents/registry.ts';
import { listPanes, switchClient, gitBranch } from './src/tmux/sessions.ts';
import { detectPorts } from './src/tmux/ports.ts';
import { sendKeys } from './src/tmux/send.ts';
import { runStatus } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { runSend } from './src/cli/send.ts';
import { runInstall, runUninstall } from './src/cli/install.ts';
import { runDoctor } from './src/cli/doctor.ts';
import { runReconcile } from './src/cli/reconcile.ts';
import { join } from 'node:path';

const VERSION: string = packageJson.version;
const REFRESH_INTERVAL_MS = 500;

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
      '  fleet                          Launch TUI dashboard',
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

// Build AgentState[] by composing hooks, events, scraper, and tmux layers.
function refreshStates(statusDirs: string[]): AgentState[] {
  const hookStatuses = readAllStatusDirs(statusDirs);
  const panes = listPanes();

  // Build port map
  const portMap = new Map<string, number[]>();
  try {
    for (const pp of detectPorts()) {
      const existing = portMap.get(pp.paneId) ?? [];
      existing.push(pp.port);
      portMap.set(pp.paneId, existing);
    }
  } catch {
    // Port detection is optional
  }

  // Index hook statuses by pane ID
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
      // Read JSONL event log
      let eventStatus: AgentStatus | null = null;
      for (const dir of statusDirs) {
        const eventsFile = join(dir, `${pane.paneNum}.events.jsonl`);
        const events = readEventLog(eventsFile);
        if (events.length > 0) {
          eventStatus = deriveStatusFromEvents(events);
          break;
        }
      }

      tool = hook.tool || null;
      ts = hook.ts;

      status = fuseState({
        hookState: hook.state,
        hookTs: hook.ts,
        eventStatus,
        scrapeStatus: null,
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
      branch: gitBranch(pane.currentPath),
      ports: portMap.get(pane.paneId) ?? [],
      ts,
      agentType: 'claude',
    });
  }

  return states;
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
      const states = refreshStates(statusDirs);
      const output = runStatus(args.slice(1), states);
      if (output.length > 0) process.stdout.write(output + '\n');
      return 0;
    }
    case 'next': {
      const states = refreshStates(statusDirs);
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
      const states = refreshStates(statusDirs);
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
      app.mode = TuiMode.DASHBOARD;
      app.sendBuffer = '';
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
      app.mode = TuiMode.DASHBOARD;
      app.sendBuffer = '';
      break;
    }
  }
}

async function launchTui(): Promise<number> {
  const registry = new AgentRegistry();
  const statusDirs = registry.statusDirs();
  const app = new TuiApp();

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

  doRefresh();

  const stopWatching = watchStatusDirs(statusDirs, () => {
    doRefresh();
    if (needsRender) draw();
  });

  return await new Promise<number>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (code: number) => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
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
      if (app.getFilter().length > 0) {
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
            case 's': {
              const selected = app.selectedState();
              if (selected) {
                app.mode = TuiMode.SEND;
                app.sendBuffer = '';
              }
              break;
            }
            case 'n': {
              const states = refreshStates(statusDirs);
              runNext(states);
              finish(0);
              return;
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

    refreshTimer = setInterval(() => {
      doRefresh();
      tick();
    }, REFRESH_INTERVAL_MS);

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
