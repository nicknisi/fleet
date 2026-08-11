import { describe, expect, test } from 'bun:test';
import { ControlProtocol } from './control-protocol.ts';

function feedAll(protocol: ControlProtocol, chunks: string[]): ReturnType<ControlProtocol['feed']> {
  let events: ReturnType<ControlProtocol['feed']> = [];
  for (const c of chunks) events = events.concat(protocol.feed(c));
  return events;
}

function blockEvents(events: ReturnType<ControlProtocol['feed']>) {
  return events.filter((e) => e.kind === 'block');
}

describe('ControlProtocol greeting', () => {
  test('consumes an unsolicited %begin/%end block as one block event', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%begin 1700000000 0 flags\n%end 1700000000 0 flags\n');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'block', tag: '0', body: '', isError: false });
  });
});

describe('ControlProtocol tag-matched termination', () => {
  test('a matching %end tag closes the block', () => {
    const p = new ControlProtocol();
    const ev = p.feed(
      '%begin 1 7 f\nline one\nline two\n%end 1 7 f\n',
    );
    expect(ev).toHaveLength(1);
    const b = ev[0]!;
    expect(b.kind).toBe('block');
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.tag).toBe('7');
    expect(b.body).toBe('line one\nline two');
    expect(b.isError).toBe(false);
  });

  test('a %end with a mismatched tag is body content, not a terminator', () => {
    const p = new ControlProtocol();
    const ev = p.feed(
      '%begin 1 7 f\n%end 1 999 f\nreal end\n%end 1 7 f\n',
    );
    const blocks = blockEvents(ev);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.body).toBe('%end 1 999 f\nreal end');
  });

  test('a %error with matching tag surfaces isError=true', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%begin 1 3 f\nboom\n%error 1 3 f\n');
    expect(ev).toHaveLength(1);
    const b = ev[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.isError).toBe(true);
    expect(b.body).toBe('boom');
    expect(b.tag).toBe('3');
  });

  test('a %error with mismatched tag is body content', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%begin 1 3 f\n%error 1 8 f\n%error 1 3 f\n');
    const blocks = blockEvents(ev);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.isError).toBe(true);
    expect(b.body).toBe('%error 1 8 f');
  });
});

describe('ControlProtocol %exit', () => {
  test('emits an exit event', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%exit\n');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'exit' });
  });

  test('%exit with trailing detail still exits', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%exit server gone\n');
    expect(ev[0]).toMatchObject({ kind: 'exit' });
  });
});

describe('ControlProtocol chunk splitting', () => {
  test('chunks split mid-line reassemble correctly', () => {
    const p = new ControlProtocol();
    const ev = feedAll(p, [
      '%beg',
      'in 1 2 f\nhel',
      'lo\n%end 1 2 ',
      'f\n',
    ]);
    const blocks = blockEvents(ev);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.body).toBe('hello');
    expect(b.tag).toBe('2');
  });

  test('chunks split mid-%end do not terminate early', () => {
    const p = new ControlProtocol();
    const ev = feedAll(p, [
      '%begin 1 5 f\nbody\n%en',
      'd 1 999 f\n%end 1 5 f\n',
    ]);
    const blocks = blockEvents(ev);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.body).toBe('body\n%end 1 999 f');
  });

  test('CRLF line endings are handled like LF', () => {
    const p = new ControlProtocol();
    const ev = p.feed('%begin 1 4 f\r\nhi\r\n%end 1 4 f\r\n');
    const b = blockEvents(ev)[0]!;
    if (b.kind !== 'block') throw new Error('unreachable');
    expect(b.body).toBe('hi');
  });

  test('a partial line with no newline is buffered across feeds', () => {
    const p = new ControlProtocol();
    expect(p.feed('no newline yet')).toEqual([]);
    const ev = p.feed(' continued\n%begin 1 1 f\nok\n%end 1 1 f\n');
    // first complete line is a notification (non-wake), then a block.
    expect(ev[0]).toMatchObject({ kind: 'notification', line: 'no newline yet continued' });
    expect(ev[1]).toMatchObject({ kind: 'block', tag: '1' });
  });
});

describe('ControlProtocol wake classification', () => {
  const wake = [
    '%window-pane-changed @1 %3',
    '%session-window-changed $1 @1',
    '%session-changed $1 foo',
    '%client-session-changed $1 foo',
    '%layout-change @1 %3 5d2e 80x24 0,0,80',
  ];
  for (const line of wake) {
    test(`wake: ${line.split(' ')[0]}`, () => {
      const p = new ControlProtocol();
      const ev = p.feed(`${line}\n`);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: 'wake', reason: line });
    });
  }

  const ignored = [
    '%output %3 hello',
    '%pane-mode-changed @1',
    '%window-add @2',
    '%unlinked-window-close @3',
    '%client-detached dev',
    '%extension tmux-pipe',
  ];
  for (const line of ignored) {
    test(`ignored (notification): ${line.split(' ')[0]}`, () => {
      const p = new ControlProtocol();
      const ev = p.feed(`${line}\n`);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: 'notification', line });
    });
  }
});

describe('ControlProtocol multiple blocks', () => {
  test('two back-to-back blocks each terminate on their own tag', () => {
    const p = new ControlProtocol();
    const ev = p.feed(
      '%begin 1 1 f\na\n%end 1 1 f\n%begin 1 2 f\nb\n%end 1 2 f\n',
    );
    const blocks = blockEvents(ev);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { body: string }).body).toBe('a');
    expect((blocks[1] as { body: string }).body).toBe('b');
  });
});
