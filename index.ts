import packageJson from './package.json' with { type: 'json' };
import { TuiApp, TuiMode } from './src/tui/app.ts';
import { render } from './src/tui/render.ts';
import { renderFooter, renderHeader, stateAtLine } from './src/tui/dashboard.ts';
import { canSendTo } from './src/tui/send.ts';
import { canKillSession } from './src/tui/kill.ts';
import { parseKeyEvent } from './src/terminal/input.ts';
import { isMouseSequence, parseMouseEvent } from './src/terminal/mouse.ts';
import {
  enterAlternateScreen,
  hideCursor,
  enterRawMode,
  enableMouse,
  restore,
  getTerminalSize,
} from './src/terminal/terminal.ts';
import { setThemeMode, C } from './src/terminal/colors.ts';
import { detectThemeMode } from './src/terminal/theme.ts';
import { fuseState } from './src/state/engine.ts';
import { readAllStatusDirs, watchStatusDirs } from './src/state/hooks.ts';
import { readLastEvents, deriveStatusFromEvents } from './src/state/events.ts';
import { acknowledgePlan } from './src/state/acknowledge.ts';
import { scrapePane } from './src/state/scraper.ts';
import { AgentStatus, ACK_ALL_RANGE, extractClaudeName, type AgentState } from './src/state/types.ts';
import { AgentRegistry } from './src/agents/registry.ts';
import { listPanesResult, switchClient, killPane, gitBranch } from './src/tmux/sessions.ts';
import { detectPorts } from './src/tmux/ports.ts';
import { sendKeys, sendRawKey } from './src/tmux/send.ts';
import { runStatus } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { runSend } from './src/cli/send.ts';
import { runInstall, runUninstall } from './src/cli/install.ts';
import { runDoctor } from './src/cli/doctor.ts';
import { runReconcile } from './src/cli/reconcile.ts';
import { runStatusLineInject, runStatusLineRemove } from './src/cli/statusline.ts';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VERSION: string = packageJson.version;
const FAST_REFRESH_MS = 500;
const SLOW_REFRESH_MS = 5000;

function printVersion(): number {
  process.stdout.write(`fleet ${VERSION}\n`);
  return 0;
}

function printHelp(): number {
  const logo = `${C.permit}f${C.question}l${C.done}e${C.busy}e${C.idle}t${C.reset}`;
  const quips = ['herding agents', 'cat wrangling', 'mission control', 'pane management', 'vibes: immaculate'];
  const quip = quips[Math.floor(Math.random() * quips.length)];

  process.stdout.write(
    [
      '',
      `  ${C.bold}${logo}${C.reset}  ${C.dim}— ${quip}${C.reset}`,
      '',
      `  ${C.bold}Dashboard${C.reset}`,
      `    ${C.idle}fleet${C.reset}                           ${C.gray}Launch TUI ${C.dim}(preview auto-opens on wide terms)${C.reset}`,
      `    ${C.idle}fleet${C.reset} --preview | --no-preview   ${C.gray}Force preview on/off${C.reset}`,
      '',
      `  ${C.bold}Commands${C.reset}`,
      `    ${C.idle}fleet status${C.reset} [--tmux] <session>  ${C.gray}Query agent state${C.reset}`,
      `    ${C.idle}fleet status${C.reset} --statusline        ${C.gray}Render multi-agent tmux status line${C.reset}`,
      `    ${C.idle}fleet next${C.reset}                       ${C.gray}Jump to next waiting agent${C.reset}`,
      `    ${C.idle}fleet send${C.reset} <session> <prompt>    ${C.gray}Send prompt to session${C.reset}`,
      `    ${C.idle}fleet reconcile${C.reset} [--dry-run]      ${C.gray}Sweep orphan status files${C.reset}`,
      '',
      `  ${C.bold}Plugin${C.reset}`,
      `    ${C.idle}fleet install${C.reset}                    ${C.gray}Register as Claude Code plugin${C.reset}`,
      `    ${C.idle}fleet uninstall${C.reset}                  ${C.gray}Remove plugin registration${C.reset}`,
      `    ${C.idle}fleet doctor${C.reset}                     ${C.gray}Health check${C.reset}`,
      '',
      `  ${C.bold}Tmux${C.reset}`,
      `    ${C.idle}fleet statusline${C.reset} --inject        ${C.gray}Add fleet status to tmux row 2${C.reset}`,
      `    ${C.idle}fleet statusline${C.reset} --remove        ${C.gray}Remove fleet status from tmux${C.reset}`,
      '',
      `  ${C.permit}⚠ waiting${C.reset}  ${C.question}? asking${C.reset}  ${C.done}✓ done${C.reset}  ${C.busy}◉ working${C.reset}  ${C.idle}● idle${C.reset}`,
      '',
    ].join('\n'),
  );
  return 0;
}

function verifyPaneState(state: AgentState, statusDirs: string[]): void {
  const scraped = scrapePane(state.paneId);
  if (scraped === null) return;
  if (scraped === state.status) return;

  const paneNum = state.paneId.replace('%', '');
  const now = Math.floor(Date.now() / 1000);
  const tmuxPid = (() => {
    try {
      const result = Bun.spawnSync({ cmd: ['tmux', 'display-message', '-p', '#{pid}'], stdout: 'pipe' });
      return parseInt(result.stdout.toString().trim(), 10) || 0;
    } catch {
      return 0;
    }
  })();

  const hookStateMap: Record<string, string> = {
    PERMIT: 'permit',
    QUESTION: 'question',
    DONE: 'done',
    BUSY: 'working',
    IDLE: 'idle',
  };
  const newHookState = hookStateMap[scraped] ?? 'idle';

  for (const dir of statusDirs) {
    const file = join(dir, `${paneNum}.status`);
    try {
      const content = readFileSync(file, 'utf-8');
      const existing = JSON.parse(content);
      if (existing.pane === state.paneId) {
        // A scraped idle screen (bare prompt, no dialog/spinner) can't be told
        // apart from a just-finished turn — both show a prompt. So never let it
        // overwrite a done/working hook state; only use it to clear a stale
        // prompt (permit/question/waiting) that's actually gone from the screen.
        if (scraped === AgentStatus.IDLE && !['permit', 'question', 'waiting'].includes(existing.state)) {
          return;
        }
        const updated = JSON.stringify({
          state: newHookState,
          pane: state.paneId,
          session: state.session,
          tool: '',
          ts: now,
          tmux_pid: tmuxPid,
        });
        writeFileSync(file, updated + '\n');
        scrapeCache.set(state.paneId, scraped);
        return;
      }
    } catch {}
  }
}

// Acknowledging a ready agent marks it seen — you've looked, so it drops out of
// the attention tier. A ready agent's DONE has two independent sources, so
// acknowledgePlan decides both actions: flip a ready status file to idle, and
// append an Acknowledged event when the event stream derives DONE (the common
// case — the bar shows DONE from a Stop event while the status file lags at
// idle). Either signal alone is enough to clear the agent. Self-gating: a
// working/waiting/asking agent derives neither, so it's left untouched.
function acknowledgePane(paneId: string, statusDirs: string[]): void {
  const paneNum = paneId.replace('%', '');
  const now = Math.floor(Date.now() / 1000);
  for (const dir of statusDirs) {
    const statusFile = join(dir, `${paneNum}.status`);
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(statusFile, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (current.pane !== paneId) continue;

    const eventsFile = join(dir, `${paneNum}.events.jsonl`);
    const recent = existsSync(eventsFile) ? readLastEvents(eventsFile, 12) : [];
    const plan = acknowledgePlan(current, recent, now);

    if (plan.status) {
      try {
        writeFileSync(statusFile, JSON.stringify(plan.status) + '\n');
      } catch {
        // Best effort — acknowledgement is non-critical
      }
    }
    if (plan.appendAck && existsSync(eventsFile)) {
      try {
        appendFileSync(eventsFile, JSON.stringify({ event: 'Acknowledged', ts: now }) + '\n');
      } catch {
        // Best effort
      }
    }
    return;
  }
}

// Acknowledge every ready agent across all tracked panes in one sweep — backs
// the status-line "clear all" chip. Reuses acknowledgePane's ready-only gating,
// so working/waiting/asking agents are left untouched.
function acknowledgeAllReady(statusDirs: string[]): void {
  for (const hook of readAllStatusDirs(statusDirs)) {
    acknowledgePane(hook.pane, statusDirs);
  }
}

// Force the tmux status bar to redraw now. Without this, an ack-in-place click
// wouldn't visibly clear until the next status-interval (~15s). Best-effort.
function refreshTmuxStatus(): void {
  try {
    Bun.spawnSync({ cmd: ['tmux', 'refresh-client', '-S'] });
  } catch {
    // Not in tmux, or refresh failed — non-critical
  }
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
let lastTmuxOk = true;

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
  const { ok: tmuxOk, panes } = listPanesResult();
  lastTmuxOk = tmuxOk;

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
        const recent = readLastEvents(eventsFile, 12);
        if (recent.length > 0) {
          eventStatus = deriveStatusFromEvents(recent);
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
      window: pane.windowName,
      claudeName: extractClaudeName(pane.paneTitle),
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
  const panes = listPanesResult().panes;
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
    case 'ack': {
      // Acknowledge a ready agent without switching to it (clears it from the
      // attention tier in place). Bound to right-click on the status line, and
      // handy for scripting. The ACK_ALL_RANGE sentinel clears every ready agent.
      const target = args[1];
      if (!target) {
        process.stderr.write('Usage: fleet ack <pane-id>\n');
        return 1;
      }
      if (target === ACK_ALL_RANGE) {
        acknowledgeAllReady(statusDirs);
      } else {
        acknowledgePane(target, statusDirs);
      }
      refreshTmuxStatus();
      return 0;
    }
    case 'switch': {
      // Invoked by the statusline left-click binding. The ACK_ALL_RANGE sentinel
      // (the "clear all" chip) clears every ready agent without switching.
      // Otherwise acknowledge the target (so a click counts the same as Enter in
      // the dashboard) and switch to it.
      const target = args[1];
      if (!target) {
        process.stderr.write('Usage: fleet switch <pane-id>\n');
        return 1;
      }
      if (target === ACK_ALL_RANGE) {
        acknowledgeAllReady(statusDirs);
        refreshTmuxStatus();
        return 0;
      }
      acknowledgePane(target, statusDirs);
      try {
        switchClient(target);
      } catch {
        // Pane may have closed
      }
      return 0;
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
    case 'statusline': {
      if (args.includes('--inject') || args.includes('--install')) {
        return runStatusLineInject();
      }
      if (args.includes('--remove') || args.includes('--uninstall')) {
        return runStatusLineRemove();
      }
      process.stderr.write('Usage: fleet statusline --inject | --remove\n');
      return 1;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      return 1;
  }
}

function handleFilterInput(
  app: TuiApp,
  key: ReturnType<typeof parseKeyEvent>,
  finish: (code: number) => void,
  statusDirs: string[],
): void {
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
        verifyPaneState(selected, statusDirs);
        acknowledgePane(selected.paneId, statusDirs);
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

function handleKillConfirmInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>, statusDirs: string[]): void {
  if (key.type === 'char' && (key.char === 'y' || key.char === 'x')) {
    const selected = app.selectedState();
    if (selected && canKillSession(selected).ok) {
      try {
        killPane(selected.paneId);
      } catch {
        // Pane may already be gone — refresh will drop it either way
      }
      app.updateStates(fullRefreshStates(statusDirs));
    }
  }
  // Any other key (or a rejected confirm) just returns to the prior mode.
  app.exitKillConfirm();
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

  // Raw mode first so the OSC 11 theme reply is readable from stdin, then the
  // rest of the terminal setup. Detection resolves in ≤150ms (0ms when an
  // explicit FLEET_THEME/@fleet-theme override is set).
  enterRawMode();
  const detectedTheme = await detectThemeMode();
  setThemeMode(detectedTheme.mode);
  enterAlternateScreen();
  hideCursor();
  enableMouse();

  let needsRender = true;

  const draw = () => {
    const size = getTerminalSize();
    process.stdout.write(render(app, size));
  };

  const doRefresh = () => {
    const states = refreshStates(statusDirs);
    app.updateStates(states);
    app.tmuxDown = !lastTmuxOk;
    app.hooksMissing = !statusDirs.some((d) => existsSync(d));
    needsRender = true;
  };

  const doFullRefresh = () => {
    const states = fullRefreshStates(statusDirs);
    app.updateStates(states);
    app.tmuxDown = !lastTmuxOk;
    app.hooksMissing = !statusDirs.some((d) => existsSync(d));
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
      if (isMouseSequence(buf)) {
        const mouse = parseMouseEvent(buf);
        if (!mouse) return;
        const sz = getTerminalSize();

        // Map a pixel (mx,my) to the agent under it, or null for chrome/off-list.
        // The session list interleaves header lines with agent rows, so route the
        // line through the scroll-aware row model instead of indexing directly.
        // Shared by the hover and click branches so their geometry can't drift.
        const listHit = (mx: number, my: number): AgentState | null => {
          const inList = app.mode === TuiMode.DASHBOARD || mx <= app.listWidth(sz.cols);
          if (!inList) return null;
          const headerHeight = renderHeader(app, sz.cols).length;
          const contentRows = sz.rows - headerHeight - renderFooter(app, sz.cols).length - 1;
          const lineIdx = my - headerHeight - 2;
          if (lineIdx < 0) return null;
          const listCols = app.mode === TuiMode.DASHBOARD ? sz.cols : app.listWidth(sz.cols);
          return stateAtLine(app, lineIdx, contentRows, listCols);
        };

        // Divider drag (preview / passthrough)
        if (app.mode === TuiMode.PREVIEW || app.mode === TuiMode.PASSTHROUGH) {
          const dividerCol = app.listWidth(sz.cols) + 1;
          if (mouse.button === 'left' && mouse.type === 'press' && Math.abs(mouse.x - dividerCol) <= 1) {
            app.startDrag();
            needsRender = true;
            return;
          }
          if (mouse.type === 'move' && app.dragging) {
            app.updateDrag(mouse.x, sz.cols);
            needsRender = true;
            return;
          }
          if (mouse.type === 'release' && app.dragging) {
            app.endDrag();
            needsRender = true;
            return;
          }
        }

        // Hover highlight — underline the row under the cursor. Any-event mouse
        // tracking (?1003) streams motion constantly, so only re-render when the
        // hovered pane actually changes; parking the cursor costs nothing.
        if (mouse.type === 'move' && !app.dragging) {
          const id = listHit(mouse.x, mouse.y)?.paneId ?? null;
          if (id !== app.hoverPaneId) {
            app.hoverPaneId = id;
            needsRender = true;
          }
          return;
        }

        // Click a session row → select it, and acknowledge it in place if it's
        // ready. Lets you clear finished agents by clicking, without leaving the
        // dashboard (statusline clicks switch instead — see `fleet switch`).
        if (
          mouse.button === 'left' &&
          mouse.type === 'press' &&
          (app.mode === TuiMode.DASHBOARD || app.mode === TuiMode.PREVIEW)
        ) {
          const sel = listHit(mouse.x, mouse.y);
          if (sel) {
            const idx = app.visibleStates().findIndex((s) => s.paneId === sel.paneId);
            if (idx >= 0) app.selectedIndex = idx;
            if (sel.status === AgentStatus.DONE) {
              acknowledgePane(sel.paneId, statusDirs);
              app.updateStates(refreshStates(statusDirs));
            }
            needsRender = true;
          }
        }
        return;
      }

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

      if (app.mode === TuiMode.CONFIRM_KILL) {
        handleKillConfirmInput(app, key, statusDirs);
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
        handleFilterInput(app, key, finish, statusDirs);
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
            case 'x': {
              if (app.selectedState()) app.enterKillConfirm();
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
            verifyPaneState(selected, statusDirs);
            acknowledgePane(selected.paneId, statusDirs);
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

    // Replay any real keystrokes swallowed during the detection window (the OSC
    // reply itself is already stripped out; only genuine input remains).
    if (detectedTheme.leftover.length > 0) {
      handleInput(detectedTheme.leftover);
      tick();
    }

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
      if (app.visibleStates().some((s) => s.status === AgentStatus.BUSY)) {
        app.pulsePhase = !app.pulsePhase;
        needsRender = true;
      }
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
