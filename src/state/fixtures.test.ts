import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFromPaneContent, detectFromTitle } from './scraper.ts';
import { loadDetectionManifest } from './detection.ts';
import { AgentStatus } from './types.ts';

// Real-capture fixture corpus sweep. Every *.txt in src/state/fixtures/ is a
// tmux capture-pane dump from a live agent pane (sources: herdr/tmux-agents-mon
// tests/fixtures). The filename encodes the expected fleet state:
//   <agent>-<expected>[-n].txt   where expected ∈ permit|question|busy|idle
// The sweep parses the stem, loads the agent's manifest, runs detectFromPaneContent
// on the split lines, and asserts the expected AgentStatus. Where a <stem>.title
// sidecar exists AND the manifest has titleRules (claude, codex), it additionally
// asserts detectFromTitle on busy/permit expectations (the title rides the fast
// tick and is the authoritative blocked/working signal for those agents).
//
// codex-idle is intentionally absent: codex's composer renders a "› <placeholder>"
// idle line, not the "❯" marker, so fleet's screen detection returns null and the
// "- project" title matches no title rule — a documented limitation (herdr
// codex.conf pulls the idle subject from rollout files, not the screen). See the
// summary in the task notes; dropped as unresolvable rather than guessed.

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const EXPECTED_TO_STATUS = {
  permit: AgentStatus.PERMIT,
  question: AgentStatus.QUESTION,
  busy: AgentStatus.BUSY,
  idle: AgentStatus.IDLE,
} satisfies Record<string, AgentStatus>;

interface FixtureCase {
  file: string;
  agent: string;
  expected: AgentStatus;
}

function discoverFixtures(): FixtureCase[] {
  const txts = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.txt') && !f.endsWith('.title'));
  const cases: FixtureCase[] = [];
  for (const file of txts) {
    const stem = file.replace(/\.txt$/, '');
    const parts = stem.split('-');
    const agent = parts[0]!;
    const expectedSlug = parts[1]!;
    if (!Object.hasOwn(EXPECTED_TO_STATUS, expectedSlug)) {
      throw new Error(`fixture "${file}" has no recognized expected state in its name`);
    }
    // SAFETY: the Object.hasOwn check above proves expectedSlug is a key of EXPECTED_TO_STATUS.
    const expected = EXPECTED_TO_STATUS[expectedSlug as keyof typeof EXPECTED_TO_STATUS];
    cases.push({ file, agent, expected });
  }
  return cases;
}

describe('fixture corpus: real captures classify to their filename-encoded state', () => {
  const cases = discoverFixtures();
  if (cases.length === 0) test('fixtures present', () => expect.unreachable('no fixtures discovered'));

  for (const c of cases) {
    describe(`${c.file} → ${c.expected}`, () => {
      const path = join(FIXTURES_DIR, c.file);
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n');
      const manifest = loadDetectionManifest(c.agent);
      const titlePath = join(FIXTURES_DIR, c.file.replace(/\.txt$/, '.title'));
      const hasTitle = existsSync(titlePath);
      const title = hasTitle ? readFileSync(titlePath, 'utf-8').trim() : '';
      const hasTitleRules = (manifest.titleRules?.length ?? 0) > 0;

      test('detectFromPaneContent matches the expected state', () => {
        expect(detectFromPaneContent(lines, manifest).status).toBe(c.expected);
      });

      if (hasTitle && hasTitleRules && (c.expected === AgentStatus.BUSY || c.expected === AgentStatus.PERMIT)) {
        test('detectFromTitle matches the expected state', () => {
          expect(detectFromTitle(title, manifest).status).toBe(c.expected);
        });
      }
    });
  }
});
