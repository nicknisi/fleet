// Shared, pure selector resolver. One grammar backs every observability verb
// (`status --json`, `watch`, `wait`, `capture`) so a selector means the same
// thing everywhere. It resolves against anything shaped like a pane — the live
// AgentState[] for the state verbs, or a lightweight {paneId, windowId,
// session, window} projection for capture — and never touches tmux or disk.
//
// Grammar (first rule that fits the raw string wins):
//   %<n>            tmux pane id      — exact match on paneId        (e.g. %42)
//   @<n>            tmux window id    — exact match on windowId      (e.g. @5)
//   <session>:<win> session + window — session AND window name      (e.g. api:build)
//   <session>       bare session      — every pane in the session    (e.g. api)
//
// A pane id or window id is expected to identify a single pane/window, but the
// resolver never dedupes — callers that require exactly one match inspect
// `matches.length` and raise AMBIGUOUS themselves, so the rule stays pure.

export type SelectorKind = 'pane' | 'window' | 'session-window' | 'session';

export interface Selectable {
  paneId: string; // %42
  windowId: string; // @5
  session: string; // session name
  window: string; // window name
}

export interface SelectorMatch<T extends Selectable> {
  raw: string;
  kind: SelectorKind;
  session: string | null; // parsed session component, when the kind carries one
  window: string | null; // parsed window-name component (session-window only)
  matches: T[];
}

export function selectorKind(raw: string): SelectorKind {
  if (raw.startsWith('%')) return 'pane';
  if (raw.startsWith('@')) return 'window';
  if (raw.includes(':')) return 'session-window';
  return 'session';
}

export function resolveSelector<T extends Selectable>(raw: string, items: readonly T[]): SelectorMatch<T> {
  const kind = selectorKind(raw);

  switch (kind) {
    case 'pane':
      return { raw, kind, session: null, window: null, matches: items.filter((i) => i.paneId === raw) };
    case 'window':
      return { raw, kind, session: null, window: null, matches: items.filter((i) => i.windowId === raw) };
    case 'session-window': {
      const idx = raw.indexOf(':');
      const session = raw.slice(0, idx);
      const window = raw.slice(idx + 1);
      return {
        raw,
        kind,
        session,
        window,
        matches: items.filter((i) => i.session === session && i.window === window),
      };
    }
    case 'session':
      return { raw, kind, session: raw, window: null, matches: items.filter((i) => i.session === raw) };
  }
}

// Human phrase for the parsed selector, used in error messages so a miss reads
// naturally ("session 'api'", "pane '%42'") instead of echoing raw syntax.
export function describeSelector(match: Pick<SelectorMatch<Selectable>, 'raw' | 'kind'>): string {
  switch (match.kind) {
    case 'pane':
      return `pane '${match.raw}'`;
    case 'window':
      return `window '${match.raw}'`;
    case 'session-window':
      return `session:window '${match.raw}'`;
    case 'session':
      return `session '${match.raw}'`;
  }
}
