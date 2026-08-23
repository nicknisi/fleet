// Persistent tmux control-mode client. One long-lived `tmux -C attach-session`
// child replaces one fork per command. Ported from snirt/tmux-agents-mon
// src/tmux.rs; pane content is never piped (capturePane uses buffer+file).
//
// This module is NEW FILES ONLY — it is not yet wired into the TUI loop. See
// the integration sketch at the bottom of this file.

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ControlProtocol, type ProtocolEvent } from './control-protocol.ts';

/** Typed error raised on %error blocks, %exit, or child death. */
export class TmuxControlError extends Error {
  override readonly name = 'TmuxControlError';
  readonly kind: 'error' | 'exit' | 'dead';
  constructor(message: string, kind: 'error' | 'exit' | 'dead') {
    super(message);
    this.kind = kind;
  }
}

/**
 * Build the argv for `tmux -C attach-session -f no-output`. When $TMUX is set
 * ("socket_path,pid,session") the first comma-field is passed as `-S <socket>`
 * so we stay on the pane's server; the var itself is stripped from the child
 * env (see childEnv) — a control client is not a nested session.
 */
export function attachArgs(tmuxEnv: string | undefined): string[] {
  const args = ['tmux'];
  if (tmuxEnv) {
    const sock = tmuxEnv.split(',')[0];
    if (sock) args.push('-S', sock);
  }
  args.push('-C', 'attach-session', '-f', 'no-output');
  return args;
}

/** Environment map as read from process.env. */
export interface EnvMap {
  [key: string]: string | undefined;
}

/** Environment map with no undefined values. */
export interface CleanEnv {
  [key: string]: string;
}

/** Copy `env` without TMUX (a control client must not look nested). */
export function childEnv(env: EnvMap): CleanEnv {
  const out: CleanEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'TMUX') continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

let syncCounter = 0;
/** Unique marker for the self-healing sync() barrier. */
export function nextSyncMarker(): string {
  return `fleet-sync-${process.pid}-${++syncCounter}`;
}

/** The three capturePane tmux commands, in order, using buffer `buf` + file. */
export function captureCommands(buf: string, paneId: string, tempFile: string): readonly [string, string, string] {
  return [
    `capture-pane -b ${buf} -t ${paneId}`,
    `save-buffer -b ${buf} ${tempFile}`,
    `delete-buffer -b ${buf}`,
  ] as const;
}

/** Drive `nextBlock()` until a body exactly equal to `marker` comes back. */
export async function drainUntilMarker(nextBlock: () => Promise<string>, marker: string): Promise<void> {
  while (true) {
    const body = await nextBlock();
    if (body === marker) return;
    // stale/unsolicited block — discard and keep reading.
  }
}

export interface TmuxControlClientOptions {
  /** Invoked (debounced) when a wake-worthy notification arrives. */
  onWake?: () => void;
  /** Debounce window for onWake. Default 100ms. */
  wakeDebounceMs?: number;
}

interface PendingSlot {
  resolve: (body: string) => void;
  reject: (err: TmuxControlError) => void;
}

export class TmuxControlClient {
  private proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | null = null;
  private readonly protocol = new ControlProtocol();
  private readonly queue: PendingSlot[] = [];
  private dead = false;
  /** Serializes run()/sync()/capturePane() so each command pairs with its block. */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly onWake?: () => void;
  private readonly wakeDebounceMs: number;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly bufferName: string;
  private readonly tempFile: string;

  constructor(opts: TmuxControlClientOptions = {}) {
    this.onWake = opts.onWake;
    this.wakeDebounceMs = opts.wakeDebounceMs ?? 100;
    this.bufferName = `fleet-${process.pid}`;
    this.tempFile = `${tmpdir()}/fleet-capture-${process.pid}`;
  }

  /** Spawn the control client, consume the greeting block, run a sync probe. */
  async connect(): Promise<void> {
    const args = attachArgs(process.env.TMUX);
    const env = childEnv(process.env);
    const proc = Bun.spawn({
      cmd: args,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env,
    });
    this.proc = proc;

    this.startReader();
    // attach emits an unsolicited %begin/%end greeting — consume it so the
    // first real run() does not pair with the wrong block.
    await this.awaitNextBlock();
    // Probe + resync barrier: confirms the pipe is aligned before first use.
    await this.sync();
  }

  /**
   * Send one tmux command, return its response body (lines joined by \n).
   * Strictly serialized; rejects with TmuxControlError on %error, %exit, or
   * spawn death.
   */
  run(cmd: string): Promise<string> {
    return this.serialize(() => this.runSerialized(cmd));
  }

  /**
   * Self-healing resync barrier: send `display-message -p <marker>` and
   * discard response blocks until one's body is exactly the marker. Any
   * stale/unsolicited blocks queued ahead of it are drained.
   */
  sync(): Promise<void> {
    const marker = nextSyncMarker();
    return this.serialize(() => drainUntilMarker(() => this.runSerialized(`display-message -p ${marker}`), marker));
  }

  /**
   * Capture pane content WITHOUT piping it through control mode (a pane
   * displaying literal "%end <t> <num>" would desync the pipe). Routes the
   * screen through a tmux buffer + temp file. The buffer is always deleted,
   * even on error; the temp file is reused across calls and unlinked in
   * close().
   */
  async capturePane(paneId: string): Promise<string> {
    const [cap, save, del] = captureCommands(this.bufferName, paneId, this.tempFile);
    try {
      await this.run(cap);
      await this.run(save);
      return await Bun.file(this.tempFile).text();
    } finally {
      // delete-buffer on every path — never leak the named buffer.
      await this.run(del).catch(() => {});
    }
  }

  /** Detach and reap the child; unlink the reusable temp file. */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.dead = true;
    this.clearWakeTimer();
    try {
      proc.stdin.write('detach-client\n');
      await proc.stdin.flush();
    } catch {
      // pipe already broken — fall through to reap.
    }
    try {
      await proc.exited;
    } catch {
      try {
        proc.kill();
      } catch {
        // already dead.
      }
      try {
        await proc.exited;
      } catch {
        // give up.
      }
    }
    try {
      await unlink(this.tempFile);
    } catch {
      // file never created or already gone.
    }
    const drained = this.queue.splice(0);
    for (const s of drained) s.reject(new TmuxControlError('tmux exited', 'exit'));
  }

  // --- internals ---------------------------------------------------------

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => task());
    // Keep the chain alive regardless of rejection so a failure in one
    // command does not poison every later command.
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private runSerialized(cmd: string): Promise<string> {
    if (this.dead || this.proc === null) {
      return Promise.reject(new TmuxControlError('tmux exited', 'dead'));
    }
    const proc = this.proc;
    const p = this.awaitNextBlock();
    try {
      proc.stdin.write(`${cmd}\n`);
      void proc.stdin.flush();
    } catch (e) {
      this.handleExit(e instanceof Error ? e : new Error(String(e)));
    }
    return p;
  }

  private awaitNextBlock(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private startReader(): void {
    const proc = this.proc;
    if (!proc) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const events = this.protocol.feed(text);
          for (const ev of events) this.dispatch(ev);
        }
        this.handleExit(new Error('tmux stdout closed'));
      } catch (e) {
        this.handleExit(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }

  private dispatch(ev: ProtocolEvent): void {
    switch (ev.kind) {
      case 'block': {
        const slot = this.queue.shift();
        if (!slot) return; // stale/unsolicited block with no pending command — drop.
        if (ev.isError) slot.reject(new TmuxControlError(ev.body, 'error'));
        else slot.resolve(ev.body);
        return;
      }
      case 'exit':
        this.handleExit(new Error('tmux exited'));
        return;
      case 'wake':
        this.scheduleWake();
        return;
      case 'notification':
        // Non-wake notifications are not actionable for fleet — dropped.
        return;
    }
  }

  private scheduleWake(): void {
    if (!this.onWake) return;
    if (this.wakeTimer !== null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.onWake?.();
    }, this.wakeDebounceMs);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private handleExit(reason: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.clearWakeTimer();
    const err = new TmuxControlError(reason.message, 'exit');
    const drained = this.queue.splice(0);
    for (const s of drained) s.reject(err);
  }
}

// ---------------------------------------------------------------------------
// Integration sketch (follow-up task — DO NOT wire in here).
//
// The TUI poll loop gains an OPTIONAL control-mode fast path:
//
//   1. Opt-in: constructed only when FLEET_CONTROL_MODE is NOT "0". The
//      existing fork path in src/tmux/ipc.ts remains the permanent fallback
//      — on ANY TmuxControlError from connect()/run()/sync()/capturePane()
//      the client is closed() and the loop reverts to ipc.ts for the rest of
//      the process. No partial control-mode state survives an error.
//   2. Lifecycle: connect() once at startup (after tmux availability check);
//      close() on exit/shutdown. The reader loop is driven by the existing
//      async tick; onWake is the debounced signal to skip the scan interval
//      and re-render immediately (focus/layout changed).
//   3. Usage: scan() replaces `tmux list-panes` + per-pane capture-pane forks
//      with `client.run(list-panes ...)` + `client.capturePane(id)`; send-keys
//      stays on ipc.ts (fire-and-forget, no response needed).
//   4. Boundaries: control.ts must NOT import the TUI; the loop imports it.
//      sessions.ts / scraper.ts / ipc.ts / index.ts are untouched in phase 1.
// ---------------------------------------------------------------------------
