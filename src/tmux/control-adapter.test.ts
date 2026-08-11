import { describe, expect, test } from 'bun:test';
import { capturePaneVia, listPanesResultVia, type ControlReadClient } from './control-adapter.ts';
import { listPanesCommand } from './sessions.ts';

// A minimal in-process stub of the control client's read surface — never
// spawns tmux. Records the commands it was asked to run so the adapters' wire
// format (quoting, command string) is unit-testable without a real server.
function fakeClient(opts: {
  run?: (cmd: string) => Promise<string>;
  capturePane?: (paneId: string) => Promise<string>;
}): ControlReadClient & { runCalls: string[]; captureCalls: string[] } {
  const runCalls: string[] = [];
  const captureCalls: string[] = [];
  return {
    runCalls,
    captureCalls,
    run: (cmd: string) => {
      runCalls.push(cmd);
      return opts.run ? opts.run(cmd) : Promise.resolve('');
    },
    capturePane: (paneId: string) => {
      captureCalls.push(paneId);
      return opts.capturePane ? opts.capturePane(paneId) : Promise.resolve('');
    },
  };
}

describe('listPanesResultVia', () => {
  test('runs listPanesCommand (single-quoted format) and parses the body identically to the fork path', async () => {
    const line = ['%3', 's', 'w', '@5', '2', '/p', '123', '1', '1', '1', 't'].join('\t');
    const client = fakeClient({ run: async () => line });
    const res = await listPanesResultVia(client);
    expect(res.ok).toBe(true);
    expect(res.panes).toHaveLength(1);
    expect(res.panes[0]!.paneId).toBe('%3');
    expect(res.panes[0]!.windowId).toBe('@5');
    expect(res.panes[0]!.focused).toBe(true);
    // The exact command string from sessions.ts is sent verbatim — no
    // re-derivation, so the fork and control paths share one format source.
    expect(client.runCalls).toEqual([listPanesCommand()]);
  });

  test('an empty body yields ok:true with no panes', async () => {
    const client = fakeClient({ run: async () => '' });
    const res = await listPanesResultVia(client);
    expect(res).toEqual({ ok: true, panes: [] });
  });

  test('propagates run() rejections (the TUI wrapper flips the latch on throw)', async () => {
    const client = fakeClient({ run: async () => Promise.reject(new Error('boom')) });
    await expect(listPanesResultVia(client)).rejects.toThrow('boom');
  });
});

describe('capturePaneVia', () => {
  test('calls client.capturePane and applies the shared line post-processing', async () => {
    const client = fakeClient({ capturePane: async () => 'line one   \nline two\n\n\n' });
    const lines = await capturePaneVia(client, '%7', 50);
    expect(lines).toEqual(['line one', 'line two']);
    expect(client.captureCalls).toEqual(['%7']);
  });

  test('respects maxLines (bottom window)', async () => {
    const client = fakeClient({ capturePane: async () => '1\n2\n3\n4\n5' });
    expect(await capturePaneVia(client, '%1', 2)).toEqual(['4', '5']);
  });

  test('propagates capturePane() rejections', async () => {
    const client = fakeClient({ capturePane: async () => Promise.reject(new Error('dead')) });
    await expect(capturePaneVia(client, '%1', 10)).rejects.toThrow('dead');
  });
});
