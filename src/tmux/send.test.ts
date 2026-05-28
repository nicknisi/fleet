import { describe, expect, test } from 'bun:test';
import { sendKeys, sendRawKey } from './send.ts';

describe('sendKeys', () => {
  test('function is exported', () => {
    expect(typeof sendKeys).toBe('function');
  });
});

describe('sendRawKey', () => {
  test('function is exported', () => {
    expect(typeof sendRawKey).toBe('function');
  });
});
