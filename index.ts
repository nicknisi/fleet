import { TuiApp, TuiMode } from './src/tui/app.ts';
import { render } from './src/tui/render.ts';
import { paneTitle, renderFooter, renderHeader, stateAtLine } from './src/tui/dashboard.ts';
import { canSendTo } from './src/tui/send.ts';
import { canKillSession } from './src/tui/kill.ts';
import { parseKeyEvent, parseKeyEvents } from './src/terminal/input.ts';
import { isMouseSequence, parseMouseEvent } from './src/terminal/mouse.ts';
import {
  enterAlternateScreen,
  hideCursor,
  enterRawMode,
  enableMouse,
  restore,
  setPaneTitle,
  getTerminalSize,
} from './src/terminal/terminal.ts';
import { setStatePalette, setThemeMode } from './src/terminal/colors.ts';
import { detectTheme, prepareTheme } from './src/terminal/theme.ts';
import { watchStatusDirs } from './src/state/hooks.ts';
import { saveRename } from './src/state/rename.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from './src/state/types.ts';
import { decideNotifications, applySuppression } from './src/notify/transitions.ts';
import { readClientFocus } from './src/tmux/clients.ts';
import { deliverDesktop } from './src/notify/deliver.ts';
import { AgentRegistry } from './src/agents/registry.ts';
import type { AgentDir } from './src/agents/config.ts';
import { switchClient, killPane } from './src/tmux/sessions.ts';
import { TmuxControlClient } from './src/tmux/control.ts';
import { shouldAttemptControl, type ControlLatch } from './src/tmux/control-router.ts';
import { sendKeys, sendKeyNames, sendRawKey } from './src/tmux/send.ts';
import { resolvePermitKeys } from './src/state/permit-keys.ts';
import { formatStatusLine } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { emitWindowColors, rollupEnabled } from './src/cli/statusline.ts';
import { handleCli } from './src/cli/router.ts';
import {
  refreshStates,
  fullRefreshStates,
  refreshStatesTui,
  fullRefreshStatesTui,
  verifyPaneState,
  acknowledgePane,
  reloadRenameCache,
  getLastTmuxOk,
} from './src/state/refresh.ts';
import { writeSegmentCache } from './src/state/segment-cache.ts';
import { existsSync } from 'node:fs';

const FAST_REFRESH_MS = 500;
const SLOW_REFRESH_MS = 5000;

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

function handleRenameInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>, dirs: AgentDir[]): void {
  switch (key.type) {
    case 'escape':
      app.exitRename();
      break;
    case 'backspace':
      app.renameBuffer = app.renameBuffer.slice(0, -1);
      break;
    case 'char':
      app.renameBuffer += key.char;
      break;
    case 'enter': {
      const selected = app.selectedState();
      if (selected) {
        saveRename(selected.session, app.renameBuffer); // empty buffer clears
        reloadRenameCache();
        app.updateStates(refreshStates(dirs)); // re-resolve customName
      }
      app.exitRename();
      break;
    }
  }
}

function handleKillConfirmInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>, dirs: AgentDir[]): void {
  if (key.type === 'char' && (key.char === 'y' || key.char === 'x')) {
    const selected = app.selectedState();
    if (selected && canKillSession(selected).ok) {
      try {
        killPane(selected.paneId);
      } catch {
        // Pane may already be gone — refresh will drop it either way
      }
      app.updateStates(fullRefreshStates(dirs));
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
  const dirs = registry.all(); // read path (agent name rides with each status)
  const statusDirs = registry.statusDirs(); // watcher + file-locating write helpers
  const app = new TuiApp();

  const args = process.argv.slice(2);
  const size = getTerminalSize();
  if (args.includes('--no-preview')) {
    app.mode = TuiMode.DASHBOARD;
  } else if (args.includes('--preview') || size.cols >= 120) {
    app.mode = TuiMode.PREVIEW;
  }

  // Read and validate the optional palette before raw mode so warnings are
  // ordinary stderr output. Raw mode then makes the OSC 11 reply readable from
  // stdin. Detection is instant inside tmux or with an
  // explicit FLEET_THEME/@fleet-theme override; only a direct terminal query
  // (outside tmux, no override) costs up to 150ms.
  const themeStartup = prepareTheme();
  enterRawMode();
  const detectedTheme = await detectTheme(themeStartup);
  if (detectedTheme.selection.palette) setStatePalette(detectedTheme.selection.palette);
  else setThemeMode(detectedTheme.selection.mode);
  enterAlternateScreen();
  hideCursor();
  enableMouse();

  let needsRender = true;

  const draw = () => {
    const size = getTerminalSize();
    process.stdout.write(render(app, size));
    // Advertise status in the pane title (deduped inside setPaneTitle);
    // restore() clears it on exit so automatic-rename falls back cleanly.
    setPaneTitle(paneTitle());
  };

  // The pane fleet itself runs in — used to suppress every toast while you're
  // watching the dashboard. Null when launched outside tmux (harmless: per-pane
  // suppression still works).
  const fleetPaneId = process.env.TMUX_PANE ?? null;
  // The running TUI is the authoritative source of the statusline segment and
  // (when the rollup is opted in) the per-window @fleet_state tints, so it
  // refreshes the cache the CLI `status --statusline` path reads and emits
  // window colors on its own tick — letting that CLI path short-circuit with
  // zero state reads / tmux forks once the cache is warm. Only meaningful inside
  // tmux; read the rollup gate once (it spawns tmux) rather than per tick.
  const insideTmux = process.env.TMUX !== undefined && process.env.TMUX.length > 0;
  const rollupOn = insideTmux && rollupEnabled();
  let lastWrittenSegment: string | null = null;
  let notifyPrev = new Map<string, AgentStatus>();

  // Compare this snapshot's statuses to the last and fire a silent desktop toast
  // on each work->stop transition, suppressing the pane you're focused on (and
  // every toast while you're watching fleet itself). Detection advances notifyPrev
  // every call, so a transition fires exactly once and re-arms on the next BUSY.
  const maybeNotify = (states: AgentState[]) => {
    const { candidates, previous } = decideNotifications(states, notifyPrev);
    notifyPrev = previous;
    if (candidates.length === 0) return; // resolve focus only when something fires
    // Empty focus set (tmux down / no clients) suppresses nothing —
    // better a redundant toast than a missed one.
    const { focusedPanes } = readClientFocus();
    for (const n of applySuppression(candidates, focusedPanes, fleetPaneId)) {
      deliverDesktop(`${STATUS_DISPLAY[n.status].label}: ${n.label}`, n.agentType, n.paneId);
    }
  };

  const applyStates = (states: AgentState[]) => {
    app.updateStates(states);
    app.tmuxDown = !getLastTmuxOk();
    app.hooksMissing = !statusDirs.some((d) => existsSync(d));
    needsRender = true;
    // Keep the CLI's statusline cache warm with the SAME renderer the CLI uses
    // (formatStatusLine) so a cached hit is byte-identical to a live compute.
    // Skip the write when the segment is unchanged since the last tick — the
    // statusline is quiet most of the time, so this is usually a no-op fs call.
    if (insideTmux) {
      const segment = formatStatusLine(states);
      if (segment !== lastWrittenSegment) {
        writeSegmentCache(segment);
        lastWrittenSegment = segment;
      }
      // Window tints used to be emitted by the CLI status path on every
      // status-interval; now that the CLI short-circuits on a cache hit while
      // the TUI runs, the TUI owns them so they stay live (one batched tmux
      // spawn per tick, gated on the opt-in @fleet_rollup option).
      if (rollupOn) emitWindowColors(states);
    }
  };

  const doRefresh = () => applyStates(refreshStates(dirs));

  const doFullRefresh = () => applyStates(fullRefreshStates(dirs));

  reloadRenameCache();
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
    // Declared (not just assigned) before finish() can run: the leftover-key
    // replay below fires synchronously before the timers are armed, and a
    // quit key there would otherwise hit the const in its temporal dead zone.
    let slowTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    // Control-mode fast path: one long-lived `tmux -C` child replaces a fork
    // per list-panes / capture-pane on the hot loop. Opt-in (TUI-only, $TMUX
    // set, FLEET_CONTROL_MODE !== '0'); connect failure or ANY later throw
    // flips the latch to dead for the whole session and the loop reverts to
    // the fork path permanently. The latch + client live in this closure.
    const controlEnabled = shouldAttemptControl(process.env);
    const controlLatch: ControlLatch = { dead: false };
    let controlClient: TmuxControlClient | null = null;
    // Guards against overlapping ticks: control reads are async, so a slow
    // tick could still be draining when the fast interval fires. Skip the
    // tick if the previous one is still running — do not queue.
    let tickInFlight = false;

    const safeCloseControl = async () => {
      const c = controlClient;
      controlClient = null;
      if (c) {
        try {
          await c.close();
        } catch {}
      }
    };

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      if (slowTimer !== null) clearInterval(slowTimer);
      if (watcherTimeout !== null) clearTimeout(watcherTimeout);
      stopWatching();
      process.stdin.removeAllListeners('data');
      // Close the control client best-effort on exit (detach + reap + unlink
      // the capture temp file). Fire-and-forget: finish() is called from sync
      // input handlers and resolve() ends the promise; the child is reaped
      // during the microtask gap before process.exit.
      void safeCloseControl();
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

        // Left-click a row → select it (single) or jump to it (double-click,
        // the same action as Enter). A single click also acks a done agent in
        // place, so you can clear finished agents without leaving the dashboard.
        // Statusline clicks switch instead — see `fleet switch`.
        if (
          mouse.button === 'left' &&
          mouse.type === 'press' &&
          (app.mode === TuiMode.DASHBOARD || app.mode === TuiMode.PREVIEW)
        ) {
          const sel = listHit(mouse.x, mouse.y);
          if (sel) {
            if (app.registerClick(sel.paneId, Date.now())) {
              // Double-click → jump to the agent, mirroring the Enter handler.
              verifyPaneState(sel, statusDirs);
              acknowledgePane(sel.paneId, statusDirs);
              finish(0);
              switchClient(sel.paneId);
              return;
            }
            const idx = app.visibleStates().findIndex((s) => s.paneId === sel.paneId);
            if (idx >= 0) app.selectedIndex = idx;
            if (sel.status === AgentStatus.DONE) {
              // Ack in place, but DON'T refresh now: a re-sort would slide the
              // row out from under a second press and break double-click on done
              // agents. The fast refresh timer reflects the ack within ~500ms.
              acknowledgePane(sel.paneId, statusDirs);
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

      // One read can coalesce several keystrokes (fast typing, SSH batching,
      // paste) — dispatch every parsed key, stopping if a key quit the app.
      for (const key of parseKeyEvents(buf)) {
        if (finished || app.shouldQuit) break;
        handleKey(key);
      }
    };

    const handleKey = (key: ReturnType<typeof parseKeyEvent>) => {
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
        handleKillConfirmInput(app, key, dirs);
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.SEND) {
        handleSendInput(app, key, finish);
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.RENAME) {
        handleRenameInput(app, key, dirs);
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
                  // Agent-aware approval: claude wants '1' (numbered menu),
                  // codex/opencode want Enter, a genuine [y/n] prompt wants a
                  // literal 'y' — resolved per agent + on-screen dialog (#40).
                  try {
                    sendKeyNames(sel.paneId, resolvePermitKeys(sel.paneId, sel.agentType, 'approve'));
                  } catch {}
                }
              }
              break;
            case 'n':
              if (app.mode === TuiMode.PREVIEW) {
                const sel = app.selectedState();
                if (sel && sel.status === AgentStatus.PERMIT) {
                  try {
                    sendKeyNames(sel.paneId, resolvePermitKeys(sel.paneId, sel.agentType, 'deny'));
                  } catch {}
                  break;
                }
              }
              {
                const states = fullRefreshStates(dirs);
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
            case 'R': {
              const sel = app.selectedState();
              if (sel) app.enterRename(sel.customName ?? '');
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

    const isTyping = () => app.mode === TuiMode.SEND || app.mode === TuiMode.RENAME || app.isFiltering();

    // Async ticks: route list-panes + capture through the control client when
    // it's live, fall back to the fork path (permanently) on any error. The
    // in-flight guard skips a tick if the previous one is still draining — it
    // never queues, so a slow control batch simply stretches the interval.
    const runFastTick = async () => {
      if (tickInFlight || finished) return;
      tickInFlight = true;
      try {
        const states = await refreshStatesTui(dirs, controlClient, controlLatch);
        if (finished) return;
        maybeNotify(states);
        if (isTyping()) return;
        applyStates(states);
        if (app.visibleStates().some((s) => s.status === AgentStatus.BUSY)) {
          app.pulsePhase = !app.pulsePhase;
          needsRender = true;
        }
        tick();
      } catch {
        // Defensive: refreshStatesTui already falls back to fork, but never
        // let an unexpected throw crash the TUI.
      } finally {
        tickInFlight = false;
      }
    };

    const runSlowTick = async () => {
      if (tickInFlight || finished) return;
      if (isTyping()) return;
      tickInFlight = true;
      try {
        const states = await fullRefreshStatesTui(dirs, controlClient, controlLatch);
        if (finished) return;
        applyStates(states);
        tick();
      } catch {
        // Defensive: fullRefreshStatesTui already falls back to fork.
      } finally {
        tickInFlight = false;
      }
    };

    // Attempt the control-mode connection (TUI-only, opt-in). Connect failure
    // is silent: controlClient stays null and every tick uses the fork path
    // for the whole session. On success the client is published so the next
    // tick reads via control; onWake (debounced ~100ms inside control.ts)
    // triggers an immediate fast tick, respecting the in-flight guard.
    if (controlEnabled) {
      const candidate = new TmuxControlClient({ onWake: () => void runFastTick() });
      void candidate
        .connect()
        .then(() => {
          if (!controlLatch.dead && !finished) controlClient = candidate;
        })
        .catch(() => {
          void candidate.close().catch(() => {});
        });
    }

    // Fast timer: keep running in passthrough (preview needs live updates).
    // Notification detection runs every tick even while typing — only the list
    // refresh + render pause, so a background agent finishing still toasts.
    refreshTimer = setInterval(() => {
      void runFastTick();
    }, FAST_REFRESH_MS);

    // Slow timer: skip if user is actively typing
    slowTimer = setInterval(() => {
      void runSlowTick();
    }, SLOW_REFRESH_MS);

    tick();
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cliResult = await handleCli(args);
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
