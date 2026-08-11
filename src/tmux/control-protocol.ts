// tmux control-mode framing: a PURE incremental state machine that turns a
// byte stream into ProtocolEvents. No I/O, no timers — just feed(chunk) ->
// events. Chunks may split anywhere (mid-line, mid-%end); CRLF and LF both
// terminate lines. Ported from snirt/tmux-agents-mon src/tmux.rs read_block.
//
// tmux control-mode framing:
//   %begin <time> <num> <flags>
//   ...body lines...
//   %end <time> <num> <flags>      (or %error <time> <num> <flags>)
//
// The <num> tag MUST match between %begin and %end/%error — a body line that
// literally contains "%end <t> <wrongnum> <f>" (e.g. pane content echoed into
// the pipe) must NOT terminate the block. Pane content is never piped here in
// fleet (capturePane routes it through a buffer+file), but the guard is kept
// for defense in depth.

export type ProtocolEvent =
  | { kind: 'block'; tag: string; body: string; isError: boolean }
  | { kind: 'wake'; reason: string }
  | { kind: 'exit' }
  | { kind: 'notification'; line: string };

// Notifications that signal a focus/layout change and should wake the poll
// loop. Everything else outside a block is emitted as 'notification' but is
// not actionable for fleet — consumers may freely ignore (drop) them.
const WAKE_PREFIXES = [
  '%window-pane-changed',
  '%session-window-changed',
  '%session-changed',
  '%client-session-changed',
  '%layout-change',
] as const;

function isWakeNotification(line: string): boolean {
  for (const p of WAKE_PREFIXES) {
    if (line.startsWith(p)) return true;
  }
  return false;
}

// "%begin <time> <num> <flags>" -> <num> (the second whitespace-delimited field).
function blockTag(rest: string): string {
  const parts = rest.split(/\s+/);
  // index 0 is the time, index 1 is the num tag.
  return parts[1] ?? '';
}

function tryBegin(line: string): string | null {
  if (!line.startsWith('%begin ')) return null;
  return blockTag(line.slice('%begin '.length));
}

// Returns 'end' | 'error' only when the terminator's tag matches the open
// block's tag; a mismatched %end/%error is pane content, not a terminator.
function tryTerminator(line: string, tag: string): 'end' | 'error' | null {
  if (line.startsWith('%end ')) {
    return blockTag(line.slice('%end '.length)) === tag ? 'end' : null;
  }
  if (line.startsWith('%error ')) {
    return blockTag(line.slice('%error '.length)) === tag ? 'error' : null;
  }
  return null;
}

interface OpenBlock {
  tag: string;
  body: string[];
}

// Pure incremental protocol decoder. Maintains a line buffer across feed()
// calls so chunks split mid-line are reassembled before processing.
export class ControlProtocol {
  private buf = '';
  private open: OpenBlock | null = null;

  feed(chunk: string): ProtocolEvent[] {
    this.buf += chunk;
    const events: ProtocolEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      // Strip a single trailing CR (CRLF -> LF normalization).
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      this.processLine(line, events);
    }
    return events;
  }

  private processLine(line: string, out: ProtocolEvent[]): void {
    const open = this.open;
    if (open !== null) {
      const term = tryTerminator(line, open.tag);
      if (term !== null) {
        out.push({
          kind: 'block',
          tag: open.tag,
          body: open.body.join('\n'),
          isError: term === 'error',
        });
        this.open = null;
        return;
      }
      // Any line inside the block — including a stray "%end <t> <wrong> <f>"
      // or a "%begin ..." — is body content, collected verbatim.
      open.body.push(line);
      return;
    }

    // Outside a block.
    const tag = tryBegin(line);
    if (tag !== null) {
      this.open = { tag, body: [] };
      return;
    }
    if (line.startsWith('%exit')) {
      out.push({ kind: 'exit' });
      return;
    }
    if (isWakeNotification(line)) {
      out.push({ kind: 'wake', reason: line });
      return;
    }
    // Non-wake notification: emitted for completeness, but fleet does not
    // act on it. Consumers may drop these without consequence.
    out.push({ kind: 'notification', line });
  }
}
