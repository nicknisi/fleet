import { expect, test } from 'bun:test';
import { AnswerInput } from './answer-input.ts';

test.each(['claude', 'codex', 'opencode'])('%s drops a coalesced suffix after Enter', (agent) => {
  const input = new AnswerInput(agent);
  expect(input.prefix(Buffer.from('\x1b[Bcafé\rnew prompt\r')).toString()).toBe('\x1b[Bcafé\r');
});

test.each(['\x1d', '\x1b[1;3B'])('Codex ends the input batch after %j', (key) => {
  expect(new AnswerInput('codex').prefix(Buffer.from(key + 'new prompt\r')).toString()).toBe(key);
});

test('raw navigation, notes and UTF-8 fragments are preserved', () => {
  const input = new AnswerInput('codex');
  for (const bytes of [Buffer.from('\x1b[B\x1b[A\tline\nnotes'), Buffer.from([0xc3]), Buffer.from([0xa9])])
    expect(input.prefix(bytes)).toEqual(bytes);
});

test('a bracketed paste keeps its CR payload and closing marker before a submit', () => {
  const paste = '\x1b[200~line one\rline two\x1b[201~';
  expect(new AnswerInput('codex').prefix(Buffer.from(paste + '\rnew prompt')).toString()).toBe(paste + '\r');
});

test('paste payloads spanning reads keep their CR bytes without hiding a later submit', () => {
  const input = new AnswerInput('codex');
  for (const chunk of ['\x1b[200~first\r', 'second\rthird'])
    expect(input.prefix(Buffer.from(chunk)).toString()).toBe(chunk);
  expect(input.prefix(Buffer.from('\x1b[201~\rnew prompt')).toString()).toBe('\x1b[201~\r');
});
