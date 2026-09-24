import { TuiApp, TuiMode } from './src/tui/app.ts';
import { render } from './src/tui/render.ts';
import { readPreview } from './src/tui/preview.ts';
import { createRefreshQueue } from './src/tui/refresh-queue.ts';
import { paneTitle, renderFooter, renderHeader, stateAtLine } from './src/tui/dashboard.ts';
import { canSendTo } from './src/tui/send.ts';
import {
  handleSendInput,
  handleKillConfirmInput,
  handlePassthroughInput,
  handleAnswerInput,
  type ActionIO,
} from './src/tui/actions.ts';
import { answersQuestionInPlace, isClaudeQuestionForm } from './src/tui/answer.ts';
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
import { switchClient, killPane, capturePane } from './src/tmux/sessions.ts';
import { TmuxControlClient } from './src/tmux/control.ts';
import { shouldAttemptControl, type ControlLatch } from './src/tmux/control-router.ts';
import { sendKeys, sendKeyNames, sendRawKey } from './src/tmux/send.ts';
import { resolvePermitKeys } from './src/state/permit-keys.ts';
import { formatStatusLine } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { chipSeparator, emitWindowColors, rollupEnabled } from './src/cli/statusline.ts';
import { handleCli } from './src/cli/router.ts';
import { buildMarkArgs, followSidebar, sidebarClients, SIDEBAR_CLIENT_FORMAT } from './src/cli/sidebar.ts';
import { tmux, tmuxOrNull } from './src/tmux/ipc.ts';
import {
  refreshStates,
  fullRefreshStates,
  refreshStatesTui,
  fullRefreshStatesTui,
  verifyPaneState,
  acknowledgePane,
  reloadRenameCache,
  getLastTmuxOk,
  refreshActionState,
} from './src/state/refresh.ts';
import { writeSegmentCache } from './src/state/segment-cache.ts';
import { writeAgentSnapshot } from './src/state/snapshot-cache.ts';
import { existsSync } from 'node:fs';

const FAST_REFRESH_MS = 500;
const SLOW_REFRESH_MS = 5000;
// Passthrough forwards keys to the live pane; a 500ms preview repaint makes the
// echo feel laggy. While in passthrough, repaint the preview at this faster
// cadence (invalidating the capture cache each tick) so keystrokes and streaming
// output track in near real time. Only runs while passthrough is active, so idle
// dashboards keep the cheap 500ms cadence.
const PASSTHROUGH_REFRESH_MS = 90;
// Half-width (in columns) of the divider grab zone. The divider is 1 column, but
// requiring a pixel-perfect press on it is hard to hit; ±3 gives a 7-column
// target while staying clear of the row-click regions on either side.
const DIVIDER_GRAB = 3;
// Bottom rows read to recognize a native question form; the form is drawn last.
const ANSWER_CAPTURE_LINES = 60;

function handleFilterInput(
  app: TuiApp,
  key: ReturnType<typeof parseKeyEvent>,
  jump: (state: AgentState) => void,
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
        jump(selected);
      }
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
      const selected = app.actionState();
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

async function launchTui(): Promise<number> {
  const registry = new AgentRegistry();
  const dirs = registry.all(); // read path (agent name rides with each status)
  const statusDirs = registry.statusDirs(); // watcher + file-locating write helpers
  const app = new TuiApp();
  const actionIO: ActionIO = {
    readState: (target) => refreshActionState(target, dirs),
    send: sendKeys,
    kill: killPane,
    forward: sendRawKey,
    capture: (pane) => capturePane(pane, ANSWER_CAPTURE_LINES),
  };
  // A pane that cannot be read has no answerable form; S falls back to sending.
  const questionFormOpen = (pane: string): boolean => {
    try {
      return isClaudeQuestionForm(actionIO.capture(pane));
    } catch {
      return false;
    }
  };

  const args = process.argv.slice(2);
  const sidebarPane = args.includes('--sidebar') ? (process.env.TMUX_PANE ?? null) : null;
  let sidebarClientPid = sidebarPane ? (process.env.FLEET_SIDEBAR_CLIENT ?? null) : null;
  if (sidebarPane) tmux(buildMarkArgs(sidebarPane));
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
  const chipSep = insideTmux ? chipSeparator() : null;
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
    // The cache writer deduplicates text and periodically renews freshness,
    // so a quiet TUI doesn't let the CLI cache expire. Failed scans must not
    // renew an empty cache and prevent the CLI from retrying live discovery.
    if (insideTmux && getLastTmuxOk()) {
      writeAgentSnapshot(states);
      writeSegmentCache(formatStatusLine(states, chipSep));
      // The TUI owns window tints while the CLI serves cached text. The emitter
      // skips unchanged batches between periodic reconciliation passes.
      if (rollupOn) emitWindowColors(states);
    }
  };

  const doFullRefresh = () => applyStates(fullRefreshStates(dirs));

  reloadRenameCache();
  doFullRefresh();

  let watcherTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopWatching = () => {};

  return await new Promise<number>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    // Declared (not just assigned) before finish() can run: the leftover-key
    // replay below fires synchronously before the timers are armed, and a
    // quit key there would otherwise hit the const in its temporal dead zone.
    let slowTimer: ReturnType<typeof setInterval> | null = null;
    // Live preview repaint, armed only while in passthrough (see tick()).
    let passthroughTimer: ReturnType<typeof setInterval> | null = null;
    let animationTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    // Control-mode fast path: one long-lived `tmux -C` child replaces a fork
    // per list-panes / capture-pane on the hot loop. Opt-in (TUI-only, $TMUX
    // set, FLEET_CONTROL_MODE !== '0'); connect failure or ANY later throw
    // flips the latch to dead for the whole session and the loop reverts to
    // the fork path permanently. The latch + client live in this closure.
    const controlEnabled = shouldAttemptControl(process.env);
    const controlLatch: ControlLatch = { dead: false };
    let controlClient: TmuxControlClient | null = null;
    let stopRefresh = () => {};
    let previewInFlight = false;
    let previewAttemptAt = 0;
    let previewAttemptPane: string | null = null;

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
      if (passthroughTimer !== null) clearInterval(passthroughTimer);
      if (animationTimer !== null) clearInterval(animationTimer);
      if (watcherTimeout !== null) clearTimeout(watcherTimeout);
      stopWatching();
      stopRefresh();
      process.stdin.removeAllListeners('data');
      // Close the control client best-effort on exit (detach + reap + unlink
      // the capture temp file). Fire-and-forget: finish() is called from sync
      // input handlers and resolve() ends the promise; the child is reaped
      // during the microtask gap before process.exit.
      void safeCloseControl();
      restore();
      resolve(code);
    };

    let lastJumpPane: string | undefined;
    const jump = (selected: AgentState) => {
      if (sidebarPane) {
        const clients = sidebarClients(tmuxOrNull(['list-clients', '-F', SIDEBAR_CLIENT_FORMAT]) ?? '');
        const client = clients.find((c) => c.pid === sidebarClientPid);
        if (!client) return; // No owner: never redirect some other attached client.
        switchClient(selected.paneId, client.name);
        tmux(['select-window', '-t', selected.paneId, ';', 'select-pane', '-t', selected.paneId]);
        // Keep the query, but leave its input mode once focus goes to the agent.
        // Otherwise a persistent, filtered sidebar would pause slow refreshes
        // and animation indefinitely while the user works elsewhere.
        app.acceptFilter();
        lastJumpPane = selected.paneId;
      } else {
        switchClient(selected.paneId);
        finish(0);
      }
      verifyPaneState(selected, statusDirs);
      acknowledgePane(selected.paneId, statusDirs);
    };

    const refreshPreview = async () => {
      if (finished || previewInFlight || (app.mode !== TuiMode.PREVIEW && !app.isLive())) return;
      const selected = app.isLive() ? app.actionState() : app.selectedState();
      if (!selected) return;
      const ttl = app.isLive() ? PASSTHROUGH_REFRESH_MS : 400;
      if (previewAttemptPane === selected.paneId && Date.now() - previewAttemptAt < ttl) return;
      previewAttemptPane = selected.paneId;
      previewAttemptAt = Date.now();
      previewInFlight = true;
      try {
        let snapshot;
        try {
          snapshot = await readPreview(selected.paneId, controlLatch.dead ? null : controlClient);
        } catch {
          // A dead control transport takes the existing permanent fork fallback.
          if (controlClient && !controlLatch.dead) {
            controlLatch.dead = true;
            void safeCloseControl();
          }
          snapshot = await readPreview(selected.paneId);
        }
        if (finished) return;
        const current = app.isLive() ? app.actionState() : app.selectedState();
        if (current?.paneId !== selected.paneId || current.panePid !== selected.panePid) return;
        app.preview = snapshot;
        // Submitting, declining or skipping closes the native form: return on
        // the next frame so nothing typed afterwards reaches the agent.
        if (app.mode === TuiMode.ANSWER && !isClaudeQuestionForm(snapshot.screen.split('\n'))) app.exitAnswer();
        needsRender = true;
        tick();
      } catch {
        if (!finished) {
          app.actionError = 'Preview unavailable';
          needsRender = true;
          tick();
        }
      } finally {
        previewInFlight = false;
      }
    };

    // Refresh observation asynchronously; rendering and key handling only read
    // the last snapshot. No capture/cursor subprocess can block a typing frame. Torn down the moment passthrough exits.
    const syncPassthroughTimer = () => {
      const active = app.isLive();
      if (active && passthroughTimer === null && !finished) {
        passthroughTimer = setInterval(() => {
          if (finished || !app.isLive()) {
            if (passthroughTimer !== null) {
              clearInterval(passthroughTimer);
              passthroughTimer = null;
            }
            return;
          }
          void refreshPreview();
        }, PASSTHROUGH_REFRESH_MS);
      } else if (!active && passthroughTimer !== null) {
        clearInterval(passthroughTimer);
        passthroughTimer = null;
      }
    };

    const tick = () => {
      if (needsRender) {
        draw();
        needsRender = false;
      }
      syncPassthroughTimer();
      if (app.shouldQuit) finish(0);
      else void refreshPreview();
    };

    const handleInput = (buf: Buffer) => {
      // Emergency exit must bypass the error-dismissal guard, including when
      // repeated preview failures would otherwise swallow every Ctrl-C.
      if (buf[0] === 0x03) {
        app.shouldQuit = true;
        needsRender = true;
        return;
      }
      if (app.actionError && !app.actionTarget) {
        // Dismiss the error with a fresh input chunk. Never reinterpret bytes
        // intended for a vanished passthrough/confirmation target as shortcuts
        // against whichever row selection fell back to.
        app.actionError = null;
        needsRender = true;
        return;
      }
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
          const contentRows =
            sz.rows - headerHeight - renderFooter(app, sz.cols).length - (app.actionError ? 1 : 0) - 1;
          const lineIdx = my - headerHeight - 2;
          if (lineIdx < 0) return null;
          const listCols = app.mode === TuiMode.DASHBOARD ? sz.cols : app.listWidth(sz.cols);
          return stateAtLine(app, lineIdx, contentRows, listCols);
        };

        // Divider drag (preview / passthrough). The grab zone is wider than the
        // 1-column divider so the press doesn't have to land exactly on the line
        // — anything within DIVIDER_GRAB columns either side starts the drag.
        if (app.mode === TuiMode.PREVIEW || app.isLive()) {
          const dividerCol = app.listWidth(sz.cols) + 1;
          if (mouse.button === 'left' && mouse.type === 'press' && Math.abs(mouse.x - dividerCol) <= DIVIDER_GRAB) {
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

        // Hover highlight — underline the row under the cursor, and (in a split
        // view) light up the divider when the cursor is over its grab zone so it
        // reads as draggable. Any-event mouse tracking (?1003) streams motion
        // constantly, so only re-render when the hovered pane or divider state
        // actually changes; parking the cursor costs nothing.
        if (mouse.type === 'move' && !app.dragging) {
          const id = listHit(mouse.x, mouse.y)?.paneId ?? null;
          const splitView = app.mode === TuiMode.PREVIEW || app.isLive();
          const overDivider = splitView && Math.abs(mouse.x - (app.listWidth(sz.cols) + 1)) <= DIVIDER_GRAB;
          if (id !== app.hoverPaneId || overDivider !== app.hoverDivider) {
            app.hoverPaneId = id;
            app.hoverDivider = overDivider;
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
              jump(sel);
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
        handlePassthroughInput(app, buf, actionIO);
        needsRender = true;
        return;
      }

      // Answering forwards raw bytes to the question form only while it is open.
      if (app.mode === TuiMode.ANSWER) {
        handleAnswerInput(app, buf, actionIO);
        needsRender = true;
        return;
      }

      // One read can coalesce several keystrokes (fast typing, SSH batching,
      // paste) — dispatch every parsed key, stopping if a key quit the app.
      for (const key of parseKeyEvents(buf)) {
        if (finished || app.shouldQuit) break;
        const wasLive = app.isLive();
        handleKey(key);
        if (app.actionError && !app.actionTarget) break;
        // Keys that follow `s` or `i` in one read were meant for the agent, but
        // the answer form or live view has not been drawn yet. Drop them rather
        // than run them as shortcuts: "sq" would quit, "ixy" would kill the pane.
        if (!wasLive && app.isLive()) break;
      }
    };

    const handleKey = (key: ReturnType<typeof parseKeyEvent>) => {
      if (key.type === 'ctrl' && key.char === 'c') {
        app.shouldQuit = true;
        return;
      }

      if (app.mode === TuiMode.HELP || app.mode === TuiMode.DECISION) {
        // Read-only overlays close on any key, returning to the dashboard.
        app.mode = TuiMode.DASHBOARD;
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.CONFIRM_KILL) {
        handleKillConfirmInput(app, key, actionIO);
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.SEND) {
        handleSendInput(app, key, actionIO);
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
        handleFilterInput(app, key, jump);
        needsRender = true;
        return;
      }

      switch (key.type) {
        case 'escape':
          if (app.getFilter().length > 0) app.clearFilter();
          else app.shouldQuit = true;
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
                    if (refreshActionState(sel, dirs).status !== AgentStatus.PERMIT)
                      throw new Error('Permission state changed');
                    sendKeyNames(sel.paneId, resolvePermitKeys(sel.paneId, sel.agentType, 'approve'));
                  } catch (error) {
                    app.actionError = error instanceof Error ? error.message : 'Approval failed';
                  }
                }
              }
              break;
            case 'n':
              if (app.mode === TuiMode.PREVIEW) {
                const sel = app.selectedState();
                if (sel && sel.status === AgentStatus.PERMIT) {
                  try {
                    if (refreshActionState(sel, dirs).status !== AgentStatus.PERMIT)
                      throw new Error('Permission state changed');
                    sendKeyNames(sel.paneId, resolvePermitKeys(sel.paneId, sel.agentType, 'deny'));
                  } catch (error) {
                    app.actionError = error instanceof Error ? error.message : 'Denial failed';
                  }
                  break;
                }
              }
              {
                const states = fullRefreshStates(dirs);
                runNext(
                  states,
                  (pane) => {
                    const selected = states.find((s) => s.paneId === pane);
                    if (selected) jump(selected);
                  },
                  sidebarPane ? (lastJumpPane ?? app.selectedState()?.paneId) : undefined,
                );
                if (!sidebarPane) finish(0);
                return;
              }
            case 's': {
              const selected = app.selectedState();
              if (selected) {
                // An asking Claude row cannot take a prompt, but its native
                // question form can be answered in place.
                if (answersQuestionInPlace(selected) && questionFormOpen(selected.paneId)) {
                  app.enterAnswer();
                  break;
                }
                const check = canSendTo(selected);
                if (check.ok) app.enterSend();
                else app.actionError = check.reason;
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
            case 'g':
              // Opt-in: toggle the repo-group view (group sibling worktrees by
              // repository instead of by session). Off by default — default
              // ordering/navigation is unchanged until pressed.
              app.toggleRepoGroupMode();
              break;
            case 'd':
              // Read-only state-provenance overlay for the selected agent —
              // renders the StateDecision already attached by the last refresh
              // (no live re-scrape), so it agrees with --json observers.
              if (app.selectedState()) app.mode = TuiMode.DECISION;
              break;
            case '/':
              app.setFilter('');
              break;
          }
          break;
        case 'enter': {
          const selected = app.selectedState();
          if (selected) {
            jump(selected);
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
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
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

    const refreshQueue = createRefreshQueue(async (slow) => {
      if (finished) return;
      try {
        const states = slow
          ? await fullRefreshStatesTui(dirs, controlClient, controlLatch)
          : await refreshStatesTui(dirs, controlClient, controlLatch);
        if (finished) return;
        if (sidebarPane) {
          sidebarClientPid = await followSidebar(
            sidebarPane,
            sidebarClientPid,
            states,
            getTerminalSize().cols,
            controlClient && !controlLatch.dead
              ? () => controlClient!.run(`list-clients -F '${SIDEBAR_CLIENT_FORMAT}'`)
              : undefined,
          );
          if (finished) return;
        }
        maybeNotify(states);
        const typing = isTyping();
        applyStates(states); // keep target validation current, even while typing
        if (!typing || app.actionError) tick();
      } catch {
        // Never let an unavailable observer crash the TUI.
      }
    });
    stopRefresh = () => refreshQueue.stop();
    stopWatching = watchStatusDirs(statusDirs, () => {
      if (watcherTimeout !== null) return;
      watcherTimeout = setTimeout(() => {
        watcherTimeout = null;
        void refreshQueue.request();
      }, 100);
    });

    // Attempt the control-mode connection (TUI-only, opt-in). Connect failure
    // is silent: controlClient stays null and every tick uses the fork path
    // for the whole session. On success the client is published so the next
    // tick reads via control; onWake (debounced ~100ms inside control.ts)
    // triggers an immediate fast tick, respecting the in-flight guard.
    if (controlEnabled) {
      const candidate = new TmuxControlClient({
        onWake: () => void refreshQueue.request(),
        wakeDebounceMs: sidebarPane ? 25 : 100,
      });
      void candidate
        .connect()
        .then(() => {
          if (!controlLatch.dead && !finished) controlClient = candidate;
        })
        .catch(() => {
          void candidate.close().catch(() => {});
        });
    }

    // Animation is independent of observation: smooth motion without polling
    // hooks/tmux any faster. Quiet dashboards and input modes do no extra work.
    animationTimer = setInterval(() => {
      if (finished || isTyping() || (app.mode !== TuiMode.DASHBOARD && app.mode !== TuiMode.PREVIEW)) return;
      if (app.summary().busy === 0) return;
      app.spinnerFrame = (app.spinnerFrame + 1) % 10;
      needsRender = true;
      tick();
    }, 100);

    // Fast timer: keep running in passthrough (preview needs live updates).
    // Notification detection runs every tick even while typing — only the list
    // refresh + render pause, so a background agent finishing still toasts.
    refreshTimer = setInterval(() => {
      void refreshQueue.request();
    }, FAST_REFRESH_MS);

    // Background discovery must not starve while a draft/query is being typed.
    slowTimer = setInterval(() => {
      void refreshQueue.request(true);
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
