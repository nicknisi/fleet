// Guards the release build matrix so artifact names and target coverage can't
// silently regress (e.g. a dropped platform or a renamed asset that mise's
// `github:` backend would no longer recognize). Parses the actual workflow
// rather than a copied list, so the test fails the moment the two diverge.
//
// Run: `bun test ./e2e/release-matrix.test.ts`

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');

// bun compile target -> published tarball basename. Every platform we ship
// lives here; arm64 keeps the `arm64` token (like darwin-arm64) so mise's
// github backend can match the host, while x64 is spelled `x86_64`.
const EXPECTED: Record<string, string> = {
  'bun-darwin-arm64': 'fleet-darwin-arm64',
  'bun-darwin-x64': 'fleet-darwin-x86_64',
  'bun-linux-x64': 'fleet-linux-x86_64',
  'bun-linux-arm64': 'fleet-linux-arm64',
};

function parseMatrix(): Record<string, string> {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const pairs: Record<string, string> = {};
  const re = /target:\s*(\S+)\s*\n\s*artifact:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) {
    pairs[m[1]!] = m[2]!;
  }
  return pairs;
}

describe('release build matrix', () => {
  test('covers exactly the expected targets with the expected artifact names', () => {
    expect(parseMatrix()).toEqual(EXPECTED);
  });

  test('includes the Linux arm64 target with a mise-recognizable arm64 asset', () => {
    const matrix = parseMatrix();
    expect(matrix['bun-linux-arm64']).toBe('fleet-linux-arm64');
    expect(matrix['bun-linux-arm64']).toContain('arm64');
  });
});
