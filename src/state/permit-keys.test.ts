import { describe, expect, test } from 'bun:test';
import { resolvePermitKeysFromLines } from './permit-keys.ts';
import { CLAUDE_MANIFEST, CODEX_MANIFEST, OPENCODE_MANIFEST, type DetectionManifest } from './detection.ts';

// Regression lock for issue #40: pressing `y` on a PERMIT agent used to send a
// literal 'y' to every agent, but claude's permission dialog is a numbered
// select menu and opencode's is a button row — both ignore 'y'. The resolver
// maps the on-screen dialog to the keys that actually answer it.

// Bottom of the real claude-blocked fixture (see detection.test.ts): the
// numbered "Do you want to proceed?" menu.
const CLAUDE_MENU_FRAME = [
  '⏺ Bash(rm -rf node_modules && npm install)',
  '  ⎿  Running…',
  '',
  '│ Do you want to proceed?',
  '│ ❯ 1. Yes',
  '│   2. No, and tell Claude what to do differently (esc)',
];

// Real opencode permission dialog frame (verified live against opencode 1.18).
const OPENCODE_PERMIT_FRAME = [
  '┃  △ Permission required',
  '┃    ← Access external directory /tmp/proj',
  '┃',
  '┃   Allow once   Allow always   Reject',
  '┃   ⇆ select  enter confirm',
];

describe('claude', () => {
  test('numbered menu dialog approves with 1, denies with Escape', () => {
    expect(resolvePermitKeysFromLines(CLAUDE_MENU_FRAME, CLAUDE_MANIFEST, 'approve')).toEqual(['1']);
    expect(resolvePermitKeysFromLines(CLAUDE_MENU_FRAME, CLAUDE_MANIFEST, 'deny')).toEqual(['Escape']);
  });

  test('a genuine [y/n] prompt keeps the literal y/n keys (rule override)', () => {
    const lines = ['Allow Edit to /path/file.ts?', '[y/n]'];
    expect(resolvePermitKeysFromLines(lines, CLAUDE_MANIFEST, 'approve')).toEqual(['y']);
    expect(resolvePermitKeysFromLines(lines, CLAUDE_MANIFEST, 'deny')).toEqual(['n']);
  });

  test('hook-sourced PERMIT with no on-screen match falls to the manifest default', () => {
    // The dialog scrolled away (or the scrape missed it) but the hook still
    // says PERMIT — the manifest default answers the agent's native dialog.
    expect(resolvePermitKeysFromLines(['❯'], CLAUDE_MANIFEST, 'approve')).toEqual(['1']);
    expect(resolvePermitKeysFromLines([], CLAUDE_MANIFEST, 'deny')).toEqual(['Escape']);
  });
});

describe('opencode', () => {
  test('permission dialog approves with Enter (Allow once preselected), denies with Escape', () => {
    expect(resolvePermitKeysFromLines(OPENCODE_PERMIT_FRAME, OPENCODE_MANIFEST, 'approve')).toEqual(['Enter']);
    expect(resolvePermitKeysFromLines(OPENCODE_PERMIT_FRAME, OPENCODE_MANIFEST, 'deny')).toEqual(['Escape']);
  });
});

describe('codex', () => {
  test('"press enter to confirm" panel approves with Enter, denies with Escape', () => {
    const lines = ['Apply this patch?', 'press enter to confirm or esc to cancel'];
    expect(resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'approve')).toEqual(['Enter']);
    expect(resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'deny')).toEqual(['Escape']);
  });

  test('a [y/n] prompt keeps the literal y/n keys (rule override)', () => {
    const lines = ['run `git push`? [y/n]'];
    expect(resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'approve')).toEqual(['y']);
    expect(resolvePermitKeysFromLines(lines, CODEX_MANIFEST, 'deny')).toEqual(['n']);
  });
});

describe('fallback', () => {
  const bare: DetectionManifest = { agent: 'mystery', linesFromBottom: 15, promptMarker: '', rules: [] };

  test('a manifest with no rules and no defaults falls back to literal y/n', () => {
    expect(resolvePermitKeysFromLines(['something? [y/n]'], bare, 'approve')).toEqual(['y']);
    expect(resolvePermitKeysFromLines(['something? [y/n]'], bare, 'deny')).toEqual(['n']);
  });

  test('a matched PERMIT rule without keys on a manifest without defaults falls back to y/n', () => {
    const m: DetectionManifest = {
      ...bare,
      rules: [{ id: 'permit.custom', pattern: 'approve\\?', state: 'PERMIT' }],
    };
    expect(resolvePermitKeysFromLines(['approve?'], m, 'approve')).toEqual(['y']);
  });

  test('only the bottom window is matched — a prompt above it cannot pick the keys', () => {
    const m: DetectionManifest = {
      ...bare,
      linesFromBottom: 2,
      rules: [{ id: 'permit.yn', pattern: '\\[y/n\\]', state: 'PERMIT', approveKeys: ['y'] }],
      approveKeys: ['Enter'],
    };
    const lines = ['old prompt [y/n]', 'line', 'line'];
    expect(resolvePermitKeysFromLines(lines, m, 'approve')).toEqual(['Enter']);
  });

  test('first matching PERMIT rule wins; non-PERMIT rules are skipped', () => {
    const m: DetectionManifest = {
      ...bare,
      rules: [
        { id: 'busy.counter', pattern: 'tokens', state: 'BUSY' },
        { id: 'permit.a', pattern: 'confirm', state: 'PERMIT', approveKeys: ['Enter'] },
        { id: 'permit.b', pattern: 'confirm', state: 'PERMIT', approveKeys: ['z'] },
      ],
    };
    expect(resolvePermitKeysFromLines(['tokens · confirm'], m, 'approve')).toEqual(['Enter']);
  });
});
