#!/usr/bin/env bun
// Zero runtime dependencies is a hard invariant for fleet: the CLI ships as a
// single `bun build --compile` binary and must never pull a package at runtime.
// This guard fails CI if a runtime `dependencies` block is ever introduced.
// devDependencies (tooling) and peerDependencies (typescript) are allowed.

import pkg from '../package.json' with { type: 'json' };

// SAFETY: pkg is this repo's own package.json via a JSON import; the guard below
// only reads these four keys, so the manifest just needs their names.
const manifest = pkg as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
};
const names = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...(manifest.bundledDependencies ?? manifest.bundleDependencies ?? []),
];

if (names.length > 0) {
  process.stderr.write(
    `check:deps — fleet must have zero runtime dependencies, found ${names.length}:\n` +
      names.map((n) => `  - ${n}`).join('\n') +
      '\nMove tooling to devDependencies, or inline the code (fleet vendors nothing at runtime).\n',
  );
  process.exit(1);
}

process.stdout.write('check:deps — ok: zero runtime dependencies\n');
