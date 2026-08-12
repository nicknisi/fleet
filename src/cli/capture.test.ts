import { describe, expect, test } from 'bun:test';
import { parseCaptureArgs, runCapture, DEFAULT_CAPTURE_LINES, type RunCaptureDeps } from './capture.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { EXIT } from './exit-codes.ts';
import { type Selectable } from '../state/selector.ts';

const pane = (over: Partial<Selectable>): Selectable => ({
  paneId: '%1',
  windowId: '@1',
  session: 'api',
  window: 'main',
  ...over,
});

// Build deps with a capture function that records how it was called and returns
// scripted lines.
function deps(over: Partial<RunCaptureDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ paneId: string; lines: number }> = [];
  const base: RunCaptureDeps = {
    panes: [pane({ paneId: '%1' })],
    capture: (paneId, lines) => {
      calls.push({ paneId, lines });
      return ['line one', 'line two'];
    },
    tmuxOk: true,
    now: 1000,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over,
  };
  return { d: base, out: () => out.join(''), err: () => err.join(''), calls };
}

describe('parseCaptureArgs', () => {
  test('parses --pane, --lines, --json, --plain', () => {
    const a = parseCaptureArgs(['--pane', '%42', '--lines', '80', '--json', '--plain']);
    expect(a.paneSelector).toBe('%42');
    expect(a.lines).toBe(80);
    expect(a.linesRaw).toBe('80');
    expect(a.json).toBe(true);
    expect(a.plain).toBe(true);
  });

  test('defaults: no pane, null lines, plain text', () => {
    const a = parseCaptureArgs([]);
    expect(a.paneSelector).toBeNull();
    expect(a.lines).toBeNull();
    expect(a.linesRaw).toBeNull();
    expect(a.json).toBe(false);
  });

  test('a non-numeric --lines is captured raw for a precise error', () => {
    const a = parseCaptureArgs(['--pane', '%1', '--lines', 'abc']);
    expect(a.linesRaw).toBe('abc');
    expect(Number.isNaN(a.lines!)).toBe(true);
  });
});

describe('runCapture — validation', () => {
  test('tmux unavailable → exit 4', () => {
    const { d, err } = deps({ tmuxOk: false });
    const code = runCapture(parseCaptureArgs(['--pane', '%1']), d);
    expect(code).toBe(EXIT.TMUX_UNAVAILABLE);
    expect(err()).toContain('tmux unavailable');
  });

  test('missing --pane → usage error, exit 1', () => {
    const { d, err } = deps();
    const code = runCapture(parseCaptureArgs([]), d);
    expect(code).toBe(EXIT.USAGE);
    expect(err()).toContain('Usage: fleet capture');
  });

  test('invalid --lines → usage error, exit 1', () => {
    const { d, err } = deps();
    const code = runCapture(parseCaptureArgs(['--pane', '%1', '--lines', 'abc']), d);
    expect(code).toBe(EXIT.USAGE);
    expect(err()).toContain("Invalid --lines 'abc'");
  });

  test('a zero/negative --lines is rejected', () => {
    const { d } = deps();
    expect(runCapture(parseCaptureArgs(['--pane', '%1', '--lines', '0']), d)).toBe(EXIT.USAGE);
    expect(runCapture(parseCaptureArgs(['--pane', '%1', '--lines', '-5']), deps().d)).toBe(EXIT.USAGE);
  });
});

describe('runCapture — resolution', () => {
  test('no pane matched → exit 2', () => {
    const { d, err } = deps({ panes: [pane({ paneId: '%1' })] });
    const code = runCapture(parseCaptureArgs(['--pane', '%999']), d);
    expect(code).toBe(EXIT.NO_MATCH);
    expect(err()).toContain('No pane matched');
  });

  test('--json returns a versioned no_match error on stdout', () => {
    const { d, out, err } = deps({ panes: [pane({ paneId: '%1' })] });
    const code = runCapture(parseCaptureArgs(['--pane', '%999', '--json']), d);
    expect(code).toBe(EXIT.NO_MATCH);
    expect(err()).toBe('');
    const envelope = JSON.parse(out());
    expect(envelope.schema).toBe(SCHEMA_VERSION);
    expect(envelope.outcome).toBe('no_match');
    expect(envelope.selector).toBe('%999');
  });

  test('ambiguous match (>1 pane) → exit 3, lists candidates', () => {
    const panes = [pane({ paneId: '%1', session: 'api' }), pane({ paneId: '%2', session: 'api' })];
    const { d, err } = deps({ panes });
    // A bare session selector can match two panes → ambiguous for capture.
    const code = runCapture(parseCaptureArgs(['--pane', 'api']), d);
    expect(code).toBe(EXIT.AMBIGUOUS);
    expect(err()).toContain('Ambiguous');
    expect(err()).toContain('%1');
    expect(err()).toContain('%2');

    const json = deps({ panes });
    expect(runCapture(parseCaptureArgs(['--pane', 'api', '--json']), json.d)).toBe(EXIT.AMBIGUOUS);
    expect(JSON.parse(json.out()).outcome).toBe('ambiguous');
  });
});

describe('runCapture — output', () => {
  test('plain (default): prints the raw buffer, trailing newline, exit 0', () => {
    const { d, out } = deps();
    const code = runCapture(parseCaptureArgs(['--pane', '%1']), d);
    expect(code).toBe(EXIT.OK);
    expect(out()).toBe('line one\nline two\n');
  });

  test('uses the default line count when --lines is omitted', () => {
    const { d, calls } = deps();
    runCapture(parseCaptureArgs(['--pane', '%1']), d);
    expect(calls[0]!.lines).toBe(DEFAULT_CAPTURE_LINES);
  });

  test('passes an explicit --lines through to the capture fn', () => {
    const { d, calls } = deps();
    runCapture(parseCaptureArgs(['--pane', '%1', '--lines', '10']), d);
    expect(calls[0]!.lines).toBe(10);
  });

  test('--json wraps the lines in the versioned envelope', () => {
    const { d, out } = deps();
    const code = runCapture(parseCaptureArgs(['--pane', '%1', '--json']), d);
    expect(code).toBe(EXIT.OK);
    const env = JSON.parse(out());
    expect(env.schema).toBe(SCHEMA_VERSION);
    expect(env.outcome).toBe('ok');
    expect(env.selector).toBe('%1');
    expect(env.pane).toBe('%1');
    expect(env.session).toBe('api');
    expect(env.lines).toEqual(['line one', 'line two']);
  });

  test('an empty buffer prints nothing on the plain path', () => {
    const { d, out } = deps({ capture: () => [] });
    const code = runCapture(parseCaptureArgs(['--pane', '%1']), d);
    expect(code).toBe(EXIT.OK);
    expect(out()).toBe('');
  });
});
