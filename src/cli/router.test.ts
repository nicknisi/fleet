import { expect, test } from 'bun:test';
import { handleCli } from './router.ts';

test('dashboard flags launch the dashboard instead of being read as commands', async () => {
  for (const args of [[], ['--preview'], ['--no-preview'], ['--sidebar'], ['--no-preview', '--sidebar']]) {
    expect(await handleCli(args)).toBeNull();
  }
});
