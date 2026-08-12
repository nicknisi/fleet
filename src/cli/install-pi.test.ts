import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { piPackageEntryMatches, upsertPiPackageEntry } from './install-pi.ts';

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

describe('upsertPiPackageEntry', () => {
  const dir = '/opt/homebrew/opt/fleet/hooks/pi';

  test('does not duplicate an existing absolute or normalized-relative entry', () => {
    expect(upsertPiPackageEntry([dir], dir)).toEqual([dir]);
    const relative = '../../Developer/fleet/hooks/pi';
    const devDir = join(homedir(), 'Developer', 'fleet', 'hooks', 'pi');
    expect(upsertPiPackageEntry([relative], devDir)).toEqual([relative]);
  });

  test('adds the canonical relative source for a new package', () => {
    const devDir = join(homedir(), 'Developer', 'fleet', 'hooks', 'pi');
    expect(upsertPiPackageEntry([], devDir)).toEqual(['../../Developer/fleet/hooks/pi']);
  });
});
