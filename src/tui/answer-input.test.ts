import { expect, test } from 'bun:test';
import { AnswerInput } from './answer-input.ts';

test.each(['claude', 'codex', 'opencode'])('%s drops a coalesced suffix after Enter', (agent) => {
  const input = new AnswerInput(agent);
  expect(input.prefix(Buffer.from('\x1b[Bcafé\rnew prompt\r')).toString()).toBe('\x1b[Bcafé\r');
});

test.each(['\x1d', '\x1b[1;3B'])('Codex ends the input batch after %j', (key) => {
  expect(new AnswerInput('codex').prefix(Buffer.from(key + 'new prompt\r')).toString()).toBe(key);
});

test.each(['async-options', 'async-editing'] as const)(
  'Codex %s ends the batch at the current Shift-Right main-prompt shortcut',
  (focus) => {
    const key = '\x1b[1;2C';
    expect(new AnswerInput('codex').prefix(Buffer.from(key + 'new prompt\r'), focus).toString()).toBe(key);
  },
);

test('raw navigation, notes and UTF-8 fragments are preserved', () => {
  const input = new AnswerInput('codex');
  for (const bytes of [Buffer.from('\x1b[B\x1b[Aline\nnotes'), Buffer.from([0xc3]), Buffer.from([0xa9])])
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

test.each(['options', 'async-options'] as const)('Codex %s cuts a numeric selection before its suffix', (focus) => {
  expect(new AnswerInput('codex').prefix(Buffer.from('1new prompt'), focus).toString()).toBe('1');
});

test('notes keep multi-digit answers and async ordinary text opens Other', () => {
  expect(new AnswerInput('codex').prefix(Buffer.from('2026 café 123'), 'editing').toString()).toBe('2026 café 123');
  expect(new AnswerInput('codex').prefix(Buffer.from('café 123'), 'async-options').toString()).toBe('café 123');
  expect(new AnswerInput('codex').prefix(Buffer.from('ignored1suffix'), 'options').toString()).toBe('ignored1');
});

test('a control before digits requires a fresh focus snapshot', () => {
  for (const focus of ['editing', 'options', 'async-editing', 'async-options'] as const) {
    for (const key of ['\t', '\x7f', '\x10', '\x0e']) {
      expect(new AnswerInput('codex').prefix(Buffer.from(key + '12text'), focus).toString()).toBe(key);
    }
  }
});

test('numbers inside a framed paste stay text even from options focus', () => {
  const input = new AnswerInput('codex');
  const paste = '\x1b[200~2026\r123\x1b[201~';
  expect(input.prefix(Buffer.from(paste + '45\rtrailing'), 'options').toString()).toBe(paste + '45\r');
});

test('ordinary text-editing controls keep following numbers in notes', () => {
  for (const key of ['\x01', '\x05', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[1;2C'])
    expect(new AnswerInput('codex').prefix(Buffer.from(key + '2026'), 'editing').toString()).toBe(key + '2026');
  for (const key of ['\x01', '\x05', '\x1b[C', '\x1b[D'])
    expect(new AnswerInput('codex').prefix(Buffer.from(key + '2026'), 'async-editing').toString()).toBe(key + '2026');
  for (const focus of ['options', 'async-options', 'async-editing'] as const)
    expect(new AnswerInput('codex').prefix(Buffer.from('\x1b[B2026'), focus).toString()).toBe('\x1b[B');
});

test('Tab stops a batch before a field transition or queued async answer', () => {
  expect(new AnswerInput('codex').prefix(Buffer.from('\tnew prompt'), 'async-editing').toString()).toBe('\t');
});
