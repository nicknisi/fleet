import { describe, expect, test } from 'bun:test';
import { runWorkmuxOpen } from './workmux-open.ts';
import { EXIT } from './exit-codes.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import type { WorkmuxEnrichment } from '../adapters/workmux.ts';

function state(paneId: string, session: string, workmux: WorkmuxEnrichment | null): AgentState {
  return {
    paneId,
    paneNum: parseInt(paneId.replace('%', ''), 10),
    session,
    window: 'main',
    windowId: '@1',
    claudeName: null,
    customName: null,
    status: AgentStatus.IDLE,
    tool: null,
    project: '~/p',
    branch: 'main',
    git: null,
    workmux,
    ports: [],
    ts: 0,
    agentType: 'claude',
  };
}

interface Harness {
  errs: string[];
  opened: string[];
  code: number;
}

function run(args: string[], opts: { states: AgentState[]; available?: boolean; openCode?: number }): Harness {
  const errs: string[] = [];
  const opened: string[] = [];
  const code = runWorkmuxOpen(args, {
    states: opts.states,
    available: () => opts.available ?? true,
    open: (handle) => {
      opened.push(handle);
      return { code: opts.openCode ?? 0, stderr: opts.openCode ? 'boom' : '' };
    },
    err: (s) => errs.push(s),
  });
  return { errs, opened, code };
}

const managed = state('%1', 'api', { managed: true, handle: 'api-wt', path: '/r/api' });
const plain = state('%2', 'web', null);

describe('runWorkmuxOpen', () => {
  test('opens a workmux-managed agent by pane selector', () => {
    const h = run(['%1'], { states: [managed, plain] });
    expect(h.code).toBe(EXIT.OK);
    expect(h.opened).toEqual(['api-wt']);
    expect(h.errs).toEqual([]);
  });

  test('opens by session selector', () => {
    const h = run(['api'], { states: [managed, plain] });
    expect(h.code).toBe(EXIT.OK);
    expect(h.opened).toEqual(['api-wt']);
  });

  test('missing selector is a usage error', () => {
    const h = run([], { states: [managed] });
    expect(h.code).toBe(EXIT.USAGE);
    expect(h.opened).toEqual([]);
    expect(h.errs.join('')).toContain('Usage');
  });

  test('workmux absent returns a clear nonzero diagnostic', () => {
    const h = run(['%1'], { states: [managed], available: false });
    expect(h.code).toBe(EXIT.USAGE);
    expect(h.opened).toEqual([]);
    expect(h.errs.join('')).toContain('workmux is not installed');
  });

  test('no selector match', () => {
    const h = run(['%99'], { states: [managed] });
    expect(h.code).toBe(EXIT.NO_MATCH);
  });

  test('ambiguous selector', () => {
    const dup = state('%3', 'api', { managed: true, handle: 'api-2', path: '/r/api2' });
    const h = run(['api'], { states: [managed, dup] });
    expect(h.code).toBe(EXIT.AMBIGUOUS);
    expect(h.opened).toEqual([]);
  });

  test('matched but unmanaged agent refuses', () => {
    const h = run(['%2'], { states: [managed, plain] });
    expect(h.code).toBe(EXIT.NO_MATCH);
    expect(h.errs.join('')).toContain('not managed by workmux');
  });

  test('surfaces a nonzero workmux open exit', () => {
    const h = run(['%1'], { states: [managed], openCode: 2 });
    expect(h.code).toBe(EXIT.USAGE);
    expect(h.errs.join('')).toContain('workmux open failed');
  });
});
