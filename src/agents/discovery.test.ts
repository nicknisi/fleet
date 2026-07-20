import { describe, expect, test } from 'bun:test';
import {
  discoverAgents,
  normalizeComm,
  parsePsTable,
  pruneDoneTracking,
  resolveDiscoveredStatus,
  walkToPane,
  parseDiscoveryConfig,
  DEFAULT_ALLOWLIST,
  DEFAULT_IDLE_SECS,
  type DiscoveredSignals,
  type DiscoveryOpts,
  type DoneTracking,
} from './discovery.ts';
import { AgentStatus } from '../state/types.ts';

// A braille spinner glyph (U+2839) — the working signal a harness paints while
// actively running. Any char in U+2800–U+28FF works.
const SPIN = '⠹';

function opts(over: Partial<DiscoveryOpts> = {}): DiscoveryOpts {
  return {
    allowlist: new Set(['aider']),
    idleSecs: 3,
    now: 100,
    lastWorking: new Map(),
    ...over,
  };
}

describe('normalizeComm', () => {
  test('strips the login-shell dash', () => {
    expect(normalizeComm('-zsh')).toBe('zsh');
  });
  test('strips a directory path to the basename', () => {
    expect(normalizeComm('/usr/bin/aider')).toBe('aider');
    expect(normalizeComm('/Applications/Foo.app/Contents/MacOS/opencode')).toBe('opencode');
  });
  test('strips a dash AND a path together', () => {
    expect(normalizeComm('-/bin/zsh')).toBe('zsh');
  });
  test('leaves a bare command untouched and trims surrounding space', () => {
    expect(normalizeComm('aider')).toBe('aider');
    expect(normalizeComm('  cursor  ')).toBe('cursor');
  });
});

describe('parsePsTable', () => {
  test('parses pid/ppid/comm with padding and normalizes comm', () => {
    const { commByPid, ppidByPid } = parsePsTable(['  100     1 -zsh', ' 300   200 /usr/local/bin/aider']);
    expect(commByPid.get(100)).toBe('zsh');
    expect(commByPid.get(300)).toBe('aider');
    expect(ppidByPid.get(300)).toBe(200);
  });
  test('ignores blank and malformed lines', () => {
    const { commByPid } = parsePsTable(['', '   ', 'garbage', ' 42 7 node']);
    expect(commByPid.size).toBe(1);
    expect(commByPid.get(42)).toBe('node');
  });
});

describe('walkToPane', () => {
  const panePids = new Map<number, string>([[100, '%1']]);

  test('2-hop chain reaches the pane', () => {
    const ppidByPid = new Map<number, number>([
      [300, 200],
      [200, 100],
    ]);
    expect(walkToPane(300, ppidByPid, panePids)).toBe('%1');
  });
  test('a chain that never reaches a pane returns null', () => {
    const ppidByPid = new Map<number, number>([
      [300, 200],
      [200, 1],
    ]);
    expect(walkToPane(300, ppidByPid, panePids)).toBeNull();
  });
  test('a ppid cycle is visited-guarded, not an infinite loop', () => {
    const ppidByPid = new Map<number, number>([
      [300, 400],
      [400, 300],
    ]);
    expect(walkToPane(300, ppidByPid, panePids)).toBeNull();
  });
});

describe('discoverAgents — mapping', () => {
  // aider(300) -> node(200) -> shell(100)=pane_pid of %1
  const psTable = ['  100     1 -zsh', '  200   100 node', '  300   200 /usr/local/bin/aider'];
  const panePids = new Map<number, string>([[100, '%1']]);

  test('(a) allowlisted aider via 2-hop chain, glyph present -> working', () => {
    const captures = new Map([['%1', `thinking ${SPIN}`]]);
    const { agents } = discoverAgents(psTable, panePids, captures, opts());
    expect(agents).toEqual([{ paneId: '%1', agentType: 'aider', working: true }]);
  });

  test('(b) glyph absent, lastWorking stale -> not working', () => {
    const captures = new Map([['%1', 'a bare prompt, no spinner']]);
    const { agents } = discoverAgents(
      psTable,
      panePids,
      captures,
      opts({ now: 100, lastWorking: new Map([['%1', 90]]) }),
    );
    expect(agents).toEqual([{ paneId: '%1', agentType: 'aider', working: false }]);
  });

  test('(c) glyph absent but lastWorking within idleSecs -> still working (debounce)', () => {
    const captures = new Map([['%1', 'no spinner right now']]);
    const { agents } = discoverAgents(
      psTable,
      panePids,
      captures,
      opts({ now: 100, idleSecs: 3, lastWorking: new Map([['%1', 98]]) }),
    );
    expect(agents[0]!.working).toBe(true);
  });

  test('(d) allowlisted pid whose chain never reaches a pane -> not discovered', () => {
    // pane_pid is 999, unreachable from the aider chain (tops out at 100).
    const { agents } = discoverAgents(psTable, new Map([[999, '%9']]), new Map(), opts());
    expect(agents).toHaveLength(0);
  });

  test('(e) non-allowlisted comm -> ignored', () => {
    const { agents } = discoverAgents(psTable, panePids, new Map(), opts({ allowlist: new Set(['cursor']) }));
    expect(agents).toHaveLength(0);
  });

  test('pathful comm normalizes and matches the bare allowlist entry', () => {
    // comm is /usr/local/bin/aider; allowlist is the bare "aider".
    const captures = new Map([['%1', SPIN]]);
    const { agents } = discoverAgents(psTable, panePids, captures, opts({ allowlist: new Set(['aider']) }));
    expect(agents[0]!.agentType).toBe('aider');
  });

  test('two allowlisted processes in one pane -> one discovered agent (first match wins)', () => {
    // Both aider(300) and cursor(250) live under pane %1's shell.
    const twoAgents = [...psTable, '  250   100 cursor'];
    const { agents } = discoverAgents(
      twoAgents,
      panePids,
      new Map(),
      opts({ allowlist: new Set(['aider', 'cursor']) }),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]!.paneId).toBe('%1');
  });

  test('empty allowlist -> zero discovered', () => {
    const { agents } = discoverAgents(psTable, panePids, new Map(), opts({ allowlist: new Set() }));
    expect(agents).toHaveLength(0);
  });

  test('no panes -> zero discovered', () => {
    const { agents } = discoverAgents(psTable, new Map(), new Map(), opts());
    expect(agents).toHaveLength(0);
  });
});

describe('discoverAgents — debounce anchoring + prune', () => {
  const psTable = ['  100     1 -zsh', '  300   100 aider'];
  const panePids = new Map<number, string>([[100, '%1']]);

  test('grace stays anchored to the last glyph, so a pane sampled faster than idleSecs still expires', () => {
    // Tick 1: glyph present at t=100.
    const t1 = discoverAgents(psTable, panePids, new Map([['%1', SPIN]]), opts({ now: 100 }));
    expect(t1.agents[0]!.working).toBe(true);
    expect(t1.lastWorking.get('%1')).toBe(100);

    // Tick 2: glyph gone at t=102 (2s later). 102-100 < 3 -> debounced working.
    const t2 = discoverAgents(
      psTable,
      panePids,
      new Map([['%1', 'idle']]),
      opts({ now: 102, lastWorking: t1.lastWorking }),
    );
    expect(t2.agents[0]!.working).toBe(true);
    // Anchor is preserved (still 100), NOT refreshed to 102.
    expect(t2.lastWorking.get('%1')).toBe(100);

    // Tick 3: glyph still gone at t=104. 104-100=4 >= 3 -> expires. Had tick 2
    // refreshed the anchor to 102, this would wrongly still read working.
    const t3 = discoverAgents(
      psTable,
      panePids,
      new Map([['%1', 'idle']]),
      opts({ now: 104, lastWorking: t2.lastWorking }),
    );
    expect(t3.agents[0]!.working).toBe(false);
  });

  test('lastWorking is pruned to currently-discovered panes', () => {
    // %9 was working last tick but is no longer discovered this tick.
    const stale = new Map([
      ['%1', 100],
      ['%9', 50],
    ]);
    const { lastWorking } = discoverAgents(psTable, panePids, new Map([['%1', SPIN]]), opts({ lastWorking: stale }));
    expect(lastWorking.has('%9')).toBe(false);
    expect(lastWorking.has('%1')).toBe(true);
  });

  test('a pane observed idle from first sight (no prior glyph) is not working', () => {
    const { agents } = discoverAgents(
      psTable,
      panePids,
      new Map([['%1', 'no spinner']]),
      opts({ lastWorking: new Map() }),
    );
    expect(agents[0]!.working).toBe(false);
  });
});

describe('parseDiscoveryConfig', () => {
  test('all unset -> enabled, default allowlist, default idle secs', () => {
    const cfg = parseDiscoveryConfig({ discover: null, agents: null, idleSecs: null });
    expect(cfg.enabled).toBe(true);
    expect(cfg.idleSecs).toBe(DEFAULT_IDLE_SECS);
    expect(cfg.allowlist).toEqual(new Set(DEFAULT_ALLOWLIST));
  });

  test('@fleet_discover off -> disabled', () => {
    expect(parseDiscoveryConfig({ discover: 'off', agents: null, idleSecs: null }).enabled).toBe(false);
  });

  test('@fleet_discover_agents override is split, normalized, trimmed', () => {
    const cfg = parseDiscoveryConfig({ discover: null, agents: 'aider, cursor ,/opt/x/opencode', idleSecs: null });
    expect(cfg.allowlist).toEqual(new Set(['aider', 'cursor', 'opencode']));
  });

  test('empty agents override yields an empty allowlist (nothing discovered)', () => {
    const cfg = parseDiscoveryConfig({ discover: null, agents: '   ,,  ', idleSecs: null });
    expect(cfg.allowlist.size).toBe(0);
  });

  test('idle secs parses a valid int; junk / negative fall back to the default', () => {
    expect(parseDiscoveryConfig({ discover: null, agents: null, idleSecs: '8' }).idleSecs).toBe(8);
    expect(parseDiscoveryConfig({ discover: null, agents: null, idleSecs: 'abc' }).idleSecs).toBe(DEFAULT_IDLE_SECS);
    expect(parseDiscoveryConfig({ discover: null, agents: null, idleSecs: '-1' }).idleSecs).toBe(DEFAULT_IDLE_SECS);
    expect(parseDiscoveryConfig({ discover: null, agents: null, idleSecs: '0' }).idleSecs).toBe(0);
  });
});

// ---- resolveDiscoveredStatus: signal fusion + the DONE state machine ----

function track(): DoneTracking {
  return { wasBusy: new Set(), done: new Set() };
}

function sig(over: Partial<DiscoveredSignals> = {}): DiscoveredSignals {
  return { glyphWorking: false, scrape: null, title: null, focused: false, ...over };
}

// The engine's fuseDiscoveredState anchors its BUSY decay window at `now`,
// measured against the real clock — so pass the real epoch (a fixed small
// number would look 50 years stale and decay every BUSY to idle).
const NOW = Math.floor(Date.now() / 1000);
function resolve(paneId: string, signals: DiscoveredSignals, tracking: DoneTracking): AgentStatus {
  return resolveDiscoveredStatus(paneId, signals, tracking, NOW);
}

describe('resolveDiscoveredStatus — prompt precedence', () => {
  test('title PERMIT wins over a co-present working glyph', () => {
    expect(resolve('%1', sig({ glyphWorking: true, title: AgentStatus.PERMIT }), track())).toBe(AgentStatus.PERMIT);
  });

  test('scrape QUESTION surfaces when the title is silent', () => {
    expect(resolve('%1', sig({ scrape: AgentStatus.QUESTION }), track())).toBe(AgentStatus.QUESTION);
  });

  test('title outranks scrape for prompts (fresher: re-read every fast tick)', () => {
    expect(resolve('%1', sig({ title: AgentStatus.PERMIT, scrape: AgentStatus.QUESTION }), track())).toBe(
      AgentStatus.PERMIT,
    );
  });

  test('scrape BUSY does not shadow a title prompt', () => {
    expect(resolve('%1', sig({ scrape: AgentStatus.BUSY, title: AgentStatus.QUESTION }), track())).toBe(
      AgentStatus.QUESTION,
    );
  });

  test('a live title spinner masks a stale scraped prompt (title takes the scrape slot)', () => {
    // The scrape can be ~5s old: an answered prompt lingering on screen must
    // not outrank a title that says the agent is actively working right now.
    expect(resolve('%1', sig({ title: AgentStatus.BUSY, scrape: AgentStatus.PERMIT }), track())).toBe(AgentStatus.BUSY);
  });

  test('glyph + scraped prompt (no title) still reads the prompt', () => {
    // With the title silent, the engine's trust-the-scraped-prompt rule holds:
    // a glyph co-present with a real on-screen dialog must not hide it.
    expect(resolve('%1', sig({ glyphWorking: true, scrape: AgentStatus.PERMIT }), track())).toBe(AgentStatus.PERMIT);
  });
});

describe('resolveDiscoveredStatus — BUSY from any positive working signal', () => {
  test('glyph alone', () => {
    expect(resolve('%1', sig({ glyphWorking: true }), track())).toBe(AgentStatus.BUSY);
  });
  test('title spinner alone', () => {
    expect(resolve('%1', sig({ title: AgentStatus.BUSY }), track())).toBe(AgentStatus.BUSY);
  });
  test('scrape BUSY alone', () => {
    expect(resolve('%1', sig({ scrape: AgentStatus.BUSY }), track())).toBe(AgentStatus.BUSY);
  });
  test('scrape IDLE is not a working signal', () => {
    expect(resolve('%1', sig({ scrape: AgentStatus.IDLE }), track())).toBe(AgentStatus.IDLE);
  });
});

describe('resolveDiscoveredStatus — DONE synthesis (finished while you were elsewhere)', () => {
  test('busy → idle while unfocused reads DONE, and DONE persists across ticks', () => {
    const t = track();
    expect(resolve('%1', sig({ glyphWorking: true }), t)).toBe(AgentStatus.BUSY);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE); // sticky
  });

  test('busy → idle while FOCUSED reads IDLE — you watched it finish', () => {
    const t = track();
    resolve('%1', sig({ glyphWorking: true }), t);
    expect(resolve('%1', sig({ focused: true }), t)).toBe(AgentStatus.IDLE);
    // And no DONE materializes later once the transition was consumed.
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.IDLE);
  });

  test('viewing the pane clears a pending DONE (clear-on-view)', () => {
    const t = track();
    resolve('%1', sig({ glyphWorking: true }), t);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
    expect(resolve('%1', sig({ focused: true }), t)).toBe(AgentStatus.IDLE);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.IDLE); // stays cleared
  });

  test('work resuming clears DONE and re-arms the transition', () => {
    const t = track();
    resolve('%1', sig({ glyphWorking: true }), t);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
    expect(resolve('%1', sig({ glyphWorking: true }), t)).toBe(AgentStatus.BUSY);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE); // fires again
  });

  test('a visible prompt holds the transition open: busy → prompt → idle still lands on DONE', () => {
    const t = track();
    resolve('%1', sig({ glyphWorking: true }), t);
    expect(resolve('%1', sig({ scrape: AgentStatus.PERMIT }), t)).toBe(AgentStatus.PERMIT);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
  });

  test('a prompt with no busy history also lands on DONE once answered (turn ended)', () => {
    const t = track();
    expect(resolve('%1', sig({ title: AgentStatus.PERMIT }), t)).toBe(AgentStatus.PERMIT);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
  });

  test('never-busy pane is plain IDLE, focused or not', () => {
    expect(resolve('%1', sig(), track())).toBe(AgentStatus.IDLE);
    expect(resolve('%1', sig({ focused: true }), track())).toBe(AgentStatus.IDLE);
  });

  test('tracking is per-pane: one pane finishing does not mark another done', () => {
    const t = track();
    resolve('%1', sig({ glyphWorking: true }), t);
    expect(resolve('%2', sig(), t)).toBe(AgentStatus.IDLE);
    expect(resolve('%1', sig(), t)).toBe(AgentStatus.DONE);
  });
});

describe('pruneDoneTracking', () => {
  test('drops entries for panes discovery no longer sees, keeps live ones', () => {
    const t: DoneTracking = { wasBusy: new Set(['%1', '%2']), done: new Set(['%3', '%4']) };
    pruneDoneTracking(t, new Set(['%1', '%3']));
    expect([...t.wasBusy]).toEqual(['%1']);
    expect([...t.done]).toEqual(['%3']);
  });
});
