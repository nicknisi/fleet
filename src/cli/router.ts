// CLI command dispatch: everything `fleet <command>` resolves to before the TUI
// is considered. Extracted verbatim from index.ts (handleCli + the version/help
// banners) — pure code movement, no behavior change. main() calls handleCli
// first; a null return means "no CLI command matched" and the TUI launches.

import packageJson from '../../package.json' with { type: 'json' };
import { C } from '../terminal/colors.ts';
import { AgentRegistry } from '../agents/registry.ts';
import type { AgentDir } from '../agents/config.ts';
import {
  fullRefreshStates,
  acknowledgePane,
  acknowledgeAllReady,
  reloadRenameCache,
  getLastTmuxOk,
} from '../state/refresh.ts';
import { ACK_ALL_RANGE, SIDEBAR_RANGE } from '../state/types.ts';
import { switchClient, listPanesResult, capturePanePlain } from '../tmux/sessions.ts';
import { tmux } from '../tmux/ipc.ts';
import { readFreshSegmentCache, writeSegmentCache } from '../state/segment-cache.ts';
import { readFreshAgentSnapshot } from '../state/snapshot-cache.ts';
import { runStatus, runStatusJson, formatStatusLine, resolveStatusLineSegment } from './status.ts';
import { runList } from './list.ts';
import { runWatch } from './watch.ts';
import { parseCaptureArgs, runCapture } from './capture.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { runSidebar } from './sidebar.ts';
import { runNext } from './next.ts';
import { runSend } from './send.ts';
import { runNotificationOpen } from './notification-open.ts';
import { runIntegrationInstall, runIntegrationUninstall } from '../agents/integrations.ts';
import { runDoctor } from './doctor.ts';
import { runReconcile } from './reconcile.ts';
import { runExplain } from './explain.ts';
import { runStatusLineInject, runStatusLineRemove, emitWindowColors, rollupEnabled } from './statusline.ts';
import { runWait, parseWaitArgs } from './wait.ts';
import { workmuxOpenCli } from './workmux-open.ts';
import type { Selectable } from '../state/selector.ts';

const VERSION: string = packageJson.version;

export function printVersion(): number {
  process.stdout.write(`fleet ${VERSION}\n`);
  return 0;
}

export function printHelp(): number {
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
      `    ${C.idle}fleet sidebar${C.reset}                    ${C.gray}Toggle the ☰ sidebar split${C.reset}`,
      `    ${C.idle}fleet send${C.reset} <session> <prompt>    ${C.gray}Send prompt to session${C.reset}`,
      `    ${C.idle}fleet wait${C.reset} <sel> --state <s>     ${C.gray}Block until agent reaches state${C.reset}`,
      `    ${C.idle}fleet explain${C.reset} <session>          ${C.gray}Trace how a session's state was decided${C.reset}`,
      `    ${C.idle}fleet workmux-open${C.reset} <selector>     ${C.gray}Focus a workmux-managed agent${C.reset}`,
      `    ${C.idle}fleet reconcile${C.reset} [--dry-run]      ${C.gray}Sweep orphan status files${C.reset}`,
      '',
      `  ${C.bold}Observe${C.reset}  ${C.dim}— machine-readable (${SCHEMA_VERSION})${C.reset}`,
      `    ${C.idle}fleet list${C.reset} [--json]              ${C.gray}List every agent${C.reset}`,
      `    ${C.idle}fleet status${C.reset} --json [<sel>]      ${C.gray}Query agent state as JSON${C.reset}`,
      `    ${C.idle}fleet watch${C.reset} [<sel>] --jsonl      ${C.gray}Stream state changes as JSON Lines${C.reset}`,
      `    ${C.idle}fleet capture${C.reset} --pane <id>        ${C.gray}Print a pane's buffer (read-only)${C.reset}`,
      `    ${C.dim}selectors: %pane  @window  session  session:window${C.reset}`,
      '',
      `  ${C.bold}Plugin${C.reset}`,
      `    ${C.idle}fleet install${C.reset}                    ${C.gray}Register as Claude Code plugin${C.reset}`,
      `    ${C.idle}fleet install codex${C.reset}              ${C.gray}Wire fleet into Codex's hooks + config${C.reset}`,
      `    ${C.idle}fleet install pi${C.reset}                 ${C.gray}Wire fleet into pi as a package extension${C.reset}`,
      `    ${C.idle}fleet uninstall${C.reset}                  ${C.gray}Remove plugin registration${C.reset}`,
      `    ${C.idle}fleet uninstall codex${C.reset}            ${C.gray}Remove fleet's Codex hooks + config${C.reset}`,
      `    ${C.idle}fleet uninstall pi${C.reset}               ${C.gray}Remove fleet's pi extension${C.reset}`,
      `    ${C.idle}fleet doctor${C.reset}                     ${C.gray}Health check${C.reset}`,
      '',
      `  ${C.bold}Tmux${C.reset}`,
      `    ${C.idle}fleet statusline${C.reset} --inject        ${C.gray}Add fleet status to tmux row 2${C.reset}`,
      `    ${C.idle}fleet statusline${C.reset} --inject --force ${C.gray}Re-apply even if already injected${C.reset}`,
      `    ${C.idle}fleet statusline${C.reset} --remove        ${C.gray}Remove fleet status from tmux${C.reset}`,
      '',
      `  ${C.permit}⚠ waiting${C.reset}  ${C.question}? asking${C.reset}  ${C.done}✓ done${C.reset}  ${C.busy}◉ working${C.reset}  ${C.idle}● idle${C.reset}`,
      '',
    ].join('\n'),
  );
  return 0;
}

// Force the tmux status bar to redraw now. Without this, an ack-in-place click
// wouldn't visibly clear until the next status-interval (~15s). Best-effort:
// tmux() swallows "not in tmux" into a non-zero exit.
function refreshTmuxStatus(): void {
  tmux(['refresh-client', '-S']);
}

// Query live state first. Machine-readable observers may fall back to the
// running TUI's last known-good snapshot when tmux is temporarily unavailable;
// getLastTmuxOk() remains false so the envelope reports stale_data honestly.
function observableStates(dirs: AgentDir[]): ReturnType<typeof fullRefreshStates> {
  const live = fullRefreshStates(dirs);
  if (getLastTmuxOk()) return live;
  return readFreshAgentSnapshot() ?? live;
}

export async function handleCli(args: string[]): Promise<number | null> {
  if (args.includes('--version') || args.includes('-v')) return printVersion();
  if (args.includes('--help') || args.includes('-h')) return printHelp();

  const command = args[0];
  if (!command) return null;

  const registry = new AgentRegistry();
  const dirs = registry.all(); // AgentDir[] for the read path (name rides with the data)
  const statusDirs = registry.statusDirs(); // string[] for the file-locating write helpers
  reloadRenameCache();

  switch (command) {
    case 'status': {
      if (args.includes('--statusline')) {
        // Serve the running TUI's already-computed segment when its cache is
        // fresh, so this cold-booted Bun process does zero state reads / tmux
        // forks on the hot path. On a miss, live-compute exactly as before and
        // seed the cache for the next status-interval. Window colors are emitted
        // by the running TUI on its own tick when the cache is fresh; on a miss
        // (TUI closed) this process still emits them as today.
        const cached = readFreshSegmentCache();
        if (cached !== null) {
          if (cached.length > 0) process.stdout.write(cached + '\n');
          return 0;
        }
        const states = fullRefreshStates(dirs);
        const { segment } = resolveStatusLineSegment(null, () => formatStatusLine(states));
        writeSegmentCache(segment);
        if (segment.length > 0) process.stdout.write(segment + '\n');
        if (rollupEnabled()) emitWindowColors(states);
        return 0;
      }
      const json = args.includes('--json');
      const states = json ? observableStates(dirs) : fullRefreshStates(dirs);
      if (json) {
        const { stdout, code } = runStatusJson(args.slice(1), states, getLastTmuxOk(), Date.now());
        process.stdout.write(stdout + '\n');
        return code;
      }
      const output = runStatus(args.slice(1), states);
      if (output.length > 0) process.stdout.write(output + '\n');
      return 0;
    }
    case 'list': {
      const json = args.includes('--json');
      const states = json ? observableStates(dirs) : fullRefreshStates(dirs);
      const { stdout, code } = runList(args.slice(1), states, getLastTmuxOk(), Date.now());
      if (stdout.length > 0) process.stdout.write(stdout + '\n');
      return code;
    }
    case 'watch': {
      // Read-only change stream. A stop flag flips on SIGINT so the loop drains
      // its current sleep and returns cleanly (timers/listeners torn down),
      // never writing status files or acknowledging anything.
      // Positional args are selectors; --jsonl (the wire format) and any other
      // flags are dropped. watch always emits JSON Lines.
      const selectors = args.slice(1).filter((a) => !a.startsWith('--'));
      let stop = false;
      const onSig = () => {
        stop = true;
      };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
      try {
        return await runWatch({
          selectors,
          getStates: () => observableStates(dirs),
          tmuxOk: () => getLastTmuxOk(),
          emit: (line) => process.stdout.write(line + '\n'),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
          stop: () => stop,
        });
      } finally {
        process.removeListener('SIGINT', onSig);
        process.removeListener('SIGTERM', onSig);
      }
    }
    case 'capture': {
      // Read-only pane capture: resolve the selector against the live pane list
      // (no state refresh, no scraping), then capture plain text. Never writes.
      const { ok, panes } = listPanesResult();
      const selectable: Selectable[] = panes.map((p) => ({
        paneId: p.paneId,
        windowId: p.windowId,
        session: p.sessionName,
        window: p.windowName,
      }));
      return runCapture(parseCaptureArgs(args.slice(1)), {
        panes: selectable,
        capture: capturePanePlain,
        tmuxOk: ok,
        now: Date.now(),
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      });
    }
    case 'next': {
      const states = fullRefreshStates(dirs);
      return runNext(states);
    }
    case 'ack': {
      // Acknowledge a ready agent without switching to it (clears it from the
      // attention tier in place). Bound to right-click on the status line, and
      // handy for scripting. The ACK_ALL_RANGE sentinel clears every ready agent;
      // the SIDEBAR_RANGE button toggles either way it's clicked, so a stray
      // right-click on it isn't a dead spot.
      const target = args[1];
      if (!target) {
        process.stderr.write('Usage: fleet ack <pane-id>\n');
        return 1;
      }
      if (target === SIDEBAR_RANGE) {
        return runSidebar(args.slice(2));
      }
      if (target === ACK_ALL_RANGE) {
        acknowledgeAllReady(dirs);
      } else {
        acknowledgePane(target, statusDirs);
      }
      refreshTmuxStatus();
      return 0;
    }
    case 'switch': {
      // Invoked by the statusline left-click binding. The ACK_ALL_RANGE sentinel
      // (the "clear all" chip) clears every ready agent without switching, and
      // SIDEBAR_RANGE (the "☰" button) toggles the sidebar. Otherwise
      // acknowledge the target (so a click counts the same as Enter in the
      // dashboard) and switch to it.
      const target = args[1];
      if (!target) {
        process.stderr.write('Usage: fleet switch <pane-id>\n');
        return 1;
      }
      if (target === SIDEBAR_RANGE) {
        return runSidebar(args.slice(2));
      }
      if (target === ACK_ALL_RANGE) {
        acknowledgeAllReady(dirs);
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
    case 'sidebar': {
      // Open the fleet sidebar split, or close it if it's already up. Same entry
      // point the status-line button routes to.
      return runSidebar(args.slice(1));
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
      const states = fullRefreshStates(dirs);
      const force = args.includes('--force');
      return runSend(session, prompt, states, force);
    }
    case 'explain': {
      const session = args[1];
      if (!session) {
        process.stderr.write('Usage: fleet explain <session> [--show-snapshot]\n');
        return 1;
      }
      const showSnapshot = args.includes('--show-snapshot');
      const states = fullRefreshStates(dirs);
      return runExplain(session, states, statusDirs, showSnapshot);
    }
    case 'install':
      // Registry-driven: bare `install` == claude (the default integration);
      // a known key (codex/pi) dispatches to its descriptor; an unknown key is
      // rejected explicitly rather than silently installing claude.
      return runIntegrationInstall(args[1]);
    case 'uninstall':
      return runIntegrationUninstall(args[1]);
    case 'notification-open': {
      return runNotificationOpen(args.slice(1));
    }
    case 'doctor':
      return runDoctor();
    case 'reconcile': {
      const dryRun = args.includes('--dry-run');
      const verbose = args.includes('--verbose');
      return runReconcile(dryRun, verbose);
    }
    case 'statusline': {
      if (args.includes('--inject') || args.includes('--install')) {
        // Silent no-op when already applied — the conf line re-runs this on
        // every tmux source-file. --force re-applies regardless.
        return runStatusLineInject(args.includes('--force'));
      }
      if (args.includes('--remove') || args.includes('--uninstall')) {
        return runStatusLineRemove();
      }
      process.stderr.write('Usage: fleet statusline --inject [--force] | --remove\n');
      return 1;
    }
    case 'workmux-open': {
      // Read-only: resolve the selector to an already-enriched agent and ask
      // workmux to focus it. Clear nonzero diagnostic when workmux is absent or
      // the pane isn't workmux-managed. Never mutates git/worktree state.
      const states = fullRefreshStates(dirs);
      return workmuxOpenCli(args.slice(1), states);
    }
    case 'wait': {
      const parsed = parseWaitArgs(args.slice(1));
      return await runWait({
        selectors: parsed.selectors,
        stateArgs: parsed.stateArgs,
        timeoutArg: parsed.timeoutArg,
        any: parsed.any,
        getStates: () => fullRefreshStates(dirs),
        tmuxOk: () => getLastTmuxOk(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      });
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      return 1;
  }
}
