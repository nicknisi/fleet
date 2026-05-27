import { describe, expect, test } from 'bun:test';
import { isMouseSequence, parseMouseEvent } from './mouse.ts';

describe('parseMouseEvent', () => {
  test('parses left-click press', () => {
    const buf = Buffer.from('\x1b[<0;10;5M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev).toEqual({ button: 'left', x: 10, y: 5, type: 'press' });
  });

  test('parses left-click release', () => {
    const buf = Buffer.from('\x1b[<0;10;5m', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev).toEqual({ button: 'left', x: 10, y: 5, type: 'release' });
  });

  test('parses right-click', () => {
    const buf = Buffer.from('\x1b[<2;7;3M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev?.button).toBe('right');
  });

  test('parses scroll up', () => {
    const buf = Buffer.from('\x1b[<64;1;1M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev?.button).toBe('scroll-up');
  });

  test('parses scroll down', () => {
    const buf = Buffer.from('\x1b[<65;1;1M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev?.button).toBe('scroll-down');
  });

  test('parses move (motion bit set)', () => {
    // 32 = motion, plus left-button = 0 -> code 32
    const buf = Buffer.from('\x1b[<32;5;5M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev?.type).toBe('move');
  });

  test('returns null for non-mouse data', () => {
    expect(parseMouseEvent(Buffer.from('hello', 'ascii'))).toBeNull();
    expect(parseMouseEvent(Buffer.from('\x1b[A', 'ascii'))).toBeNull();
  });

  test('returns null for short buffer', () => {
    expect(parseMouseEvent(Buffer.from('\x1b[<', 'ascii'))).toBeNull();
  });

  test('parses large coordinates (SGR mode advantage)', () => {
    const buf = Buffer.from('\x1b[<0;250;180M', 'ascii');
    const ev = parseMouseEvent(buf);
    expect(ev).toEqual({ button: 'left', x: 250, y: 180, type: 'press' });
  });
});

describe('isMouseSequence', () => {
  test('detects SGR mouse prefix', () => {
    expect(isMouseSequence(Buffer.from('\x1b[<0;1;1M', 'ascii'))).toBe(true);
  });

  test('rejects arrow key', () => {
    expect(isMouseSequence(Buffer.from('\x1b[A', 'ascii'))).toBe(false);
  });

  test('rejects empty buffer', () => {
    expect(isMouseSequence(Buffer.from('', 'ascii'))).toBe(false);
  });
});
