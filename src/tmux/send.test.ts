import { describe, expect, test } from 'bun:test';
import { sendKeys, sendRawKey } from './send.ts';

describe('sendKeys', () => {
  test('function is exported', () => {
    expect(sendKeys).toBeFunction();
  });
});

describe('sendRawKey', () => {
  test('function is exported', () => {
    expect(sendRawKey).toBeFunction();
  });
});
