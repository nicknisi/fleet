import { describe, expect, test } from 'bun:test';
import { sendKeys } from './send.ts';

describe('sendKeys', () => {
  test('function is exported', () => {
    expect(typeof sendKeys).toBe('function');
  });
});
