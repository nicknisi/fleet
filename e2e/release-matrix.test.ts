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
const FORMULA = join(import.meta.dir, '..', 'Formula', 'fleet.rb');

interface StringMap {
  [key: string]: string;
}

// bun compile target -> published tarball basename. Every platform we ship
// lives here; arm64 keeps the `arm64` token (like darwin-arm64) so mise's
// github backend can match the host, while x64 is spelled `x86_64`.
const EXPECTED: StringMap = {
  'bun-darwin-arm64': 'fleet-darwin-arm64',
  'bun-darwin-x64': 'fleet-darwin-x86_64',
  'bun-linux-x64': 'fleet-linux-x86_64',
  'bun-linux-arm64': 'fleet-linux-arm64',
};

function parseMatrix(): StringMap {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const pairs: StringMap = {};
  const re = /target:\s*(\S+)\s*\n\s*artifact:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) {
    pairs[m[1]!] = m[2]!;
  }
  return pairs;
}

// Tarball basenames the canonical formula points its download URLs at.
function parseFormulaAssets(): Set<string> {
  const rb = readFileSync(FORMULA, 'utf8');
  const assets = new Set<string>();
  const re = /url "[^"]*\/(fleet-[a-z0-9_-]+\.tar\.gz)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rb)) !== null) {
    assets.add(m[1]!);
  }
  return assets;
}

// asset filename -> the shell var the release job substitutes into the tap.
function parseChecksumMap(): StringMap {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const map: StringMap = {};
  const re = /'(fleet-[a-z0-9_-]+\.tar\.gz)':\s*'\$\{(SHA_\w+)\}'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) {
    map[m[1]!] = m[2]!;
  }
  return map;
}

// shell var -> the asset it is computed from via `shasum -a 256 <asset>`.
function parseChecksumSources(): StringMap {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const src: StringMap = {};
  const re = /(SHA_\w+)=\$\(shasum -a 256 (fleet-[a-z0-9_-]+\.tar\.gz)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) {
    src[m[1]!] = m[2]!;
  }
  return src;
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

describe('formula/artifact parity', () => {
  test('canonical formula ships exactly the built artifacts', () => {
    const built = new Set(Object.values(parseMatrix()).map((a) => `${a}.tar.gz`));
    expect(parseFormulaAssets()).toEqual(built);
  });

  test('release job maps every formula asset to its own checksum, exactly once', () => {
    const assets = parseFormulaAssets();
    const map = parseChecksumMap();
    const sources = parseChecksumSources();

    // The tap substitution must cover exactly the formula's assets.
    expect(new Set(Object.keys(map))).toEqual(assets);

    // No cross-wiring: each asset's checksum var is computed from that same asset.
    for (const [asset, shaVar] of Object.entries(map)) {
      expect(sources[shaVar]).toBe(asset);
    }
  });
});
