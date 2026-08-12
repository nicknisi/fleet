import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { piPackageEntryMatches } from './install-pi.ts';

describe('piPackageEntryMatches', () => {
  const dir = '/opt/homebrew/opt/fleet/hooks/pi';

  test('matches a string local-package entry', () => {
    expect(piPackageEntryMatches(dir, dir)).toBe(true);
    expect(piPackageEntryMatches('/other/package', dir)).toBe(false);
  });

  test('matches an object entry by source', () => {
    expect(piPackageEntryMatches({ source: dir, extensions: ['./fleet-pi.ts'] }, dir)).toBe(true);
    expect(piPackageEntryMatches({ source: '/other/package' }, dir)).toBe(false);
  });

  test("matches pi's normalized relative local-package source", () => {
    const devDir = join(homedir(), 'Developer', 'fleet', 'hooks', 'pi');
    expect(piPackageEntryMatches('../../Developer/fleet/hooks/pi', devDir)).toBe(true);
    expect(piPackageEntryMatches({ source: '../../Developer/fleet/hooks/pi' }, devDir)).toBe(true);
  });

  test('ignores non-source shapes and substring matches', () => {
    expect(piPackageEntryMatches(`${dir}/fleet-pi.ts`, dir)).toBe(false);
    expect(piPackageEntryMatches({ path: dir }, dir)).toBe(false);
    expect(piPackageEntryMatches([dir], dir)).toBe(false);
    expect(piPackageEntryMatches(null, dir)).toBe(false);
  });
});
