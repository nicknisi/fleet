# Fleet — Agent Dashboard TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Bun CLI/TUI that manages multiple AI agent sessions in tmux, replacing ~10 scattered bash scripts with a single project that also acts as a Claude Code plugin for hook auto-discovery.

**Architecture:** Bash hooks (delivered via Claude Code plugin system) write JSON status files and append to JSONL event logs. A Bun TUI reads those files, fuses three state layers (hooks, events, pane scraping) into a high-confidence state per pane, and renders an interactive dashboard. CLI subcommands (`fleet status`, `fleet next`, `fleet send`, etc.) provide non-interactive access for scripting and tmux integration.

**Tech Stack:** Bun (runtime + build + test), TypeScript (strict, TS 6+), oxlint, oxfmt, release-please, GitHub Actions CI/CD. Zero runtime dependencies. Mirrors `tm` project's toolchain exactly.

---

## File Structure

```
~/Developer/fleet/
├── plugin.json                  # Claude Code plugin manifest
├── package.json                 # Bun project, bin: { fleet: ./dist/fleet }
├── tsconfig.json                # Strict TS config (matches tm)
├── .oxlintrc.json               # oxlint config
├── .oxfmtrc.json                # oxfmt config
├── .gitignore                   # Standard Bun ignores
├── .release-please-config.json  # release-please node config
├── .release-please-manifest.json
├── .github/
│   └── workflows/
│       ├── ci.yml               # lint, format, typecheck, compile
│       ├── release.yml          # release-please + cross-compile + homebrew
│       └── lint-pr-title.yml    # conventional commits
├── Formula/
│   └── fleet.rb                 # Homebrew formula reference
├── hooks/
│   ├── hooks.json               # Claude Code plugin hook declarations
│   ├── lib.sh                   # Shared: write status, append JSONL, notify
│   ├── notification.sh          # PERMIT / QUESTION / DONE splitting
│   ├── pre-tool-use.sh          # → BUSY
│   ├── stop.sh                  # → DONE (grace period + bg task guard)
│   ├── subagent-stop.sh         # → DONE
│   └── session-end.sh           # Cleanup status file
├── index.ts                     # Entry point: CLI flag parsing + dispatch
├── src/
│   ├── state/
│   │   ├── types.ts             # State enum, AgentState, priority map
│   │   ├── hooks.ts             # Layer 1: read status files + file watcher
│   │   ├── events.ts            # Layer 2: JSONL event log parser
│   │   ├── scraper.ts           # Layer 3: tmux capture-pane + process detection
│   │   └── engine.ts            # Fuses 3 layers → AgentState per pane
│   ├── tui/
│   │   ├── app.ts               # App state (sessions, selection, mode)
│   │   ├── dashboard.ts         # Dashboard view (session list + columns)
│   │   ├── preview.ts           # Preview pane (capture-pane rendering)
│   │   ├── send.ts              # Send mode (text input + state gating)
│   │   ├── help.ts              # Help overlay
│   │   └── render.ts            # Full-screen ANSI renderer (composes views)
│   ├── terminal/
│   │   ├── terminal.ts          # Raw mode, alt screen, cursor, mouse, cleanup
│   │   ├── input.ts             # Key event parsing
│   │   ├── mouse.ts             # SGR mouse protocol
│   │   ├── ansi.ts              # Strip, width calc, truncation (CJK/emoji)
│   │   └── colors.ts            # Color codes with NO_COLOR support
│   ├── tmux/
│   │   ├── ipc.ts               # Bun.spawnSync('tmux', ...) wrappers
│   │   ├── sessions.ts          # List sessions/windows/panes, parse output
│   │   ├── send.ts              # send-keys with multi-line M-Enter support
│   │   └── ports.ts             # Listening port detection per pane
│   ├── agents/
│   │   ├── config.ts            # Read agents.json / agents.conf (backward compat)
│   │   └── registry.ts          # Agent type → status dir mapping
│   └── cli/
│       ├── status.ts            # fleet status [--tmux]
│       ├── next.ts              # fleet next
│       ├── send.ts              # fleet send <session> <prompt>
│       ├── install.ts           # fleet install / uninstall
│       ├── doctor.ts            # fleet doctor
│       └── reconcile.ts         # fleet reconcile
└── test/
    └── fixtures/                # Sample status files, JSONL logs
```

---

### Task 1: Project Scaffolding

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.oxlintrc.json`
- Create: `.oxfmtrc.json`
- Create: `.gitignore`
- Create: `.release-please-config.json`
- Create: `.release-please-manifest.json`
- Create: `CLAUDE.md`
- Create: `LICENSE`

- [ ] **Step 1: Initialize git repo**

```bash
cd ~/Developer/fleet
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "fleet",
  "version": "0.1.0",
  "description": "Agent dashboard TUI for managing AI sessions in tmux",
  "module": "index.ts",
  "type": "module",
  "license": "MIT",
  "homepage": "https://github.com/nicknisi/fleet",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/nicknisi/fleet.git"
  },
  "bugs": {
    "url": "https://github.com/nicknisi/fleet/issues"
  },
  "bin": {
    "fleet": "./dist/fleet"
  },
  "scripts": {
    "dev": "bun run index.ts",
    "build": "bun build --compile --minify index.ts --outfile dist/fleet",
    "lint": "oxlint",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "oxfmt": "^0.47.0",
    "oxlint": "^1.62.0"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "types": ["bun"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

- [ ] **Step 4: Create .oxlintrc.json**

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": null,
  "categories": {},
  "rules": {},
  "env": {
    "builtin": true
  },
  "globals": {},
  "ignorePatterns": ["dist/**"]
}
```

- [ ] **Step 5: Create .oxfmtrc.json**

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "trailingCommas": "all",
  "tabWidth": 2,
  "semi": true,
  "singleQuote": true,
  "printWidth": 120,
  "sortPackageJson": false,
  "ignorePatterns": ["dist/", "node_modules/", "CHANGELOG.md", ".github/"]
}
```

- [ ] **Step 6: Create .gitignore**

```
node_modules
out
dist
*.tgz
coverage
*.lcov
logs
*.log
.env
.env.development.local
.env.test.local
.env.production.local
.env.local
.eslintcache
.cache
*.tsbuildinfo
.idea
.DS_Store
*.bun-build
```

- [ ] **Step 7: Create release-please config**

`.release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "packages": {
    ".": {
      "package-name": "fleet"
    }
  }
}
```

`.release-please-manifest.json`:

```json
{
  ".": "0.1.0"
}
```

- [ ] **Step 8: Create CLAUDE.md**

```markdown
# Fleet

Agent dashboard TUI for managing AI agent sessions in tmux. Also a Claude Code plugin for hook auto-discovery.

## Architecture

Bash hooks write state → Bun TUI reads state. Three-layer state engine: hook signals, JSONL event stream, pane scraping.

## Development

- Runtime: Bun
- Build: `bun run build` (compiles to standalone binary)
- Test: `bun test`
- Lint: `bun run lint`
- Format: `bun run format`
- Typecheck: `bun run typecheck`
- Dev: `bun run dev` (runs without compiling)

## Conventions

- Zero runtime dependencies
- TypeScript strict mode with noUncheckedIndexedAccess
- Collocated tests: `*.test.ts` next to source
- Raw ANSI rendering (no TUI framework)
- Single-string-per-frame rendering (no flicker)
```

- [ ] **Step 9: Create LICENSE (MIT)**

Use standard MIT license text with `Nick Nisi` and `2026`.

- [ ] **Step 10: Install dependencies**

```bash
cd ~/Developer/fleet
bun install
```

- [ ] **Step 11: Verify toolchain**

```bash
bun run typecheck
bun run lint
bun run format:check
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: initial project scaffolding"
```

---

### Task 2: State Types

**Files:**

- Create: `src/state/types.ts`
- Test: `src/state/types.test.ts`

- [ ] **Step 1: Write failing test for state priority ordering**

Create `src/state/types.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { AgentStatus, statusPriority, compareStatus } from './types.ts';

describe('statusPriority', () => {
  test('PERMIT is highest priority', () => {
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.QUESTION));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.DONE));
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
  });

  test('needs-you states sort above BUSY', () => {
    expect(statusPriority(AgentStatus.PERMIT)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.QUESTION)).toBeLessThan(statusPriority(AgentStatus.BUSY));
    expect(statusPriority(AgentStatus.DONE)).toBeLessThan(statusPriority(AgentStatus.BUSY));
  });

  test('DOWN is lowest priority', () => {
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.SHELL));
    expect(statusPriority(AgentStatus.DOWN)).toBeGreaterThan(statusPriority(AgentStatus.IDLE));
  });
});

describe('compareStatus', () => {
  test('sorts higher priority first', () => {
    const statuses = [AgentStatus.IDLE, AgentStatus.PERMIT, AgentStatus.BUSY, AgentStatus.DONE];
    statuses.sort(compareStatus);
    expect(statuses).toEqual([AgentStatus.PERMIT, AgentStatus.DONE, AgentStatus.BUSY, AgentStatus.IDLE]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/state/types.test.ts
```

Expected: FAIL — module `./types.ts` not found.

- [ ] **Step 3: Implement state types**

Create `src/state/types.ts`:

```typescript
export const AgentStatus = {
  PERMIT: 'PERMIT',
  QUESTION: 'QUESTION',
  DONE: 'DONE',
  BUSY: 'BUSY',
  IDLE: 'IDLE',
  SHELL: 'SHELL',
  DOWN: 'DOWN',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

const PRIORITY: Record<AgentStatus, number> = {
  [AgentStatus.PERMIT]: 0,
  [AgentStatus.QUESTION]: 1,
  [AgentStatus.DONE]: 2,
  [AgentStatus.BUSY]: 3,
  [AgentStatus.IDLE]: 4,
  [AgentStatus.SHELL]: 5,
  [AgentStatus.DOWN]: 6,
};

export function statusPriority(status: AgentStatus): number {
  return PRIORITY[status];
}

export function compareStatus(a: AgentStatus, b: AgentStatus): number {
  return PRIORITY[a] - PRIORITY[b];
}

export interface StatusColors {
  icon: string;
  fg: string;
}

export const STATUS_DISPLAY: Record<AgentStatus, { icon: string; label: string; color: string }> = {
  [AgentStatus.PERMIT]: { icon: '⚠', label: 'PERMIT', color: '#f9e2af' },
  [AgentStatus.QUESTION]: { icon: '?', label: 'QUESTION', color: '#cba6f7' },
  [AgentStatus.DONE]: { icon: '✓', label: 'DONE', color: '#a6e3a1' },
  [AgentStatus.BUSY]: { icon: '◉', label: 'BUSY', color: '#fab387' },
  [AgentStatus.IDLE]: { icon: '●', label: 'IDLE', color: '#89b4fa' },
  [AgentStatus.SHELL]: { icon: '■', label: 'SHELL', color: '#6c7086' },
  [AgentStatus.DOWN]: { icon: '○', label: 'DOWN', color: '#45475a' },
};

export interface AgentState {
  paneId: string;
  paneNum: number;
  session: string;
  status: AgentStatus;
  tool: string | null;
  project: string | null;
  branch: string | null;
  ports: number[];
  ts: number;
  agentType: string;
}

export interface HookStatus {
  state: string;
  pane: string;
  session: string;
  tool: string;
  ts: number;
  tmux_pid: number;
}

export interface EventEntry {
  event: string;
  ts: number;
  tool?: string;
  stop_reason?: string;
  background_tasks?: boolean;
  notification_type?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/state/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/types.test.ts
git commit -m "feat: add state types with priority ordering"
```

---

### Task 3: Terminal Primitives (ported from tm)

**Files:**

- Create: `src/terminal/ansi.ts` (copy from tm, identical)
- Create: `src/terminal/ansi.test.ts` (copy from tm)
- Create: `src/terminal/colors.ts` (extended with catppuccin palette)
- Create: `src/terminal/mouse.ts` (copy from tm, identical)
- Create: `src/terminal/mouse.test.ts` (copy from tm)
- Create: `src/terminal/terminal.ts` (copy from tm, identical)
- Create: `src/terminal/input.ts` (adapted for fleet keybindings)

- [ ] **Step 1: Create ansi.ts**

Copy `tm/src/ansi.ts` verbatim — the `stripAnsi`, `visibleLength`, and `truncateAnsi` functions are identical.

- [ ] **Step 2: Create ansi.test.ts**

Copy `tm/src/ansi.test.ts` verbatim.

- [ ] **Step 3: Create colors.ts with catppuccin palette**

```typescript
const isTTY = process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR;
let forceNoColor = false;

export function disableColors(): void {
  forceNoColor = true;
}

function code(c: string): string {
  if (forceNoColor || noColor || !isTTY) return '';
  return c;
}

function rgb(r: number, g: number, b: number): string {
  return code(`\x1b[38;2;${r};${g};${b}m`);
}

export const C = {
  get reset() {
    return code('\x1b[0m');
  },
  get bold() {
    return code('\x1b[1m');
  },
  get dim() {
    return code('\x1b[2m');
  },
  get red() {
    return code('\x1b[0;31m');
  },
  get green() {
    return code('\x1b[0;32m');
  },
  get blue() {
    return code('\x1b[0;34m');
  },
  get purple() {
    return code('\x1b[0;35m');
  },
  get cyan() {
    return code('\x1b[0;36m');
  },
  get cyanBold() {
    return code('\x1b[1;36m');
  },
  get yellow() {
    return code('\x1b[0;33m');
  },
  get yellowBold() {
    return code('\x1b[1;33m');
  },
  get greenBold() {
    return code('\x1b[1;32m');
  },
  get whiteBold() {
    return code('\x1b[1;37m');
  },
  get gray() {
    return code('\x1b[0;90m');
  },
  // Catppuccin Mocha palette for state colors
  get permit() {
    return rgb(249, 226, 175);
  }, // #f9e2af yellow
  get question() {
    return rgb(203, 166, 247);
  }, // #cba6f7 mauve
  get done() {
    return rgb(166, 227, 161);
  }, // #a6e3a1 green
  get busy() {
    return rgb(250, 179, 135);
  }, // #fab387 peach
  get idle() {
    return rgb(137, 180, 250);
  }, // #89b4fa blue
  get shell() {
    return rgb(108, 112, 134);
  }, // #6c7086 overlay0
  get down() {
    return rgb(69, 71, 90);
  }, // #45475a surface1
} as const;
```

- [ ] **Step 4: Create mouse.ts**

Copy `tm/src/mouse.ts` verbatim.

- [ ] **Step 5: Create mouse.test.ts**

Copy `tm/src/mouse.test.ts` verbatim.

- [ ] **Step 6: Create terminal.ts**

Copy `tm/src/terminal.ts` verbatim — the raw mode, alt screen, cursor, mouse, cleanup, and `withTerminal` helper are identical.

- [ ] **Step 7: Create input.ts**

```typescript
import type { KeyEvent } from './types.ts';

export type { KeyEvent };

export type KeyEventType =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'backspace' }
  | { type: 'tab' }
  | { type: 'arrow'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'ctrl'; char: string }
  | { type: 'unknown' };

export function parseKeyEvent(data: Buffer): KeyEventType {
  if (data.length === 0) return { type: 'unknown' };

  const first = data[0]!;

  if (first === 0x1b) {
    if (data.length === 1) return { type: 'escape' };
    if (data.length >= 3 && data[1] === 0x5b) {
      const final = data[2];
      switch (final) {
        case 0x41:
          return { type: 'arrow', direction: 'up' };
        case 0x42:
          return { type: 'arrow', direction: 'down' };
        case 0x43:
          return { type: 'arrow', direction: 'right' };
        case 0x44:
          return { type: 'arrow', direction: 'left' };
        default:
          return { type: 'unknown' };
      }
    }
    return { type: 'escape' };
  }

  if (first === 0x0d) return { type: 'enter' };
  if (first === 0x7f) return { type: 'backspace' };
  if (first === 0x09) return { type: 'tab' };

  if (first >= 0x01 && first <= 0x1a) {
    const char = String.fromCharCode(first + 0x60);
    return { type: 'ctrl', char };
  }

  if (first >= 0x20 && first <= 0x7e) {
    return { type: 'char', char: String.fromCharCode(first) };
  }

  if (first >= 0xc0) {
    return { type: 'char', char: data.toString('utf8') };
  }

  return { type: 'unknown' };
}
```

Note: The `KeyEvent` type is reused directly from `tm`'s approach. The `types.ts` in the terminal directory doesn't exist yet — we'll define `KeyEvent` inline here as `KeyEventType` and export it.

- [ ] **Step 8: Run tests**

```bash
bun test src/terminal/
```

Expected: PASS for ansi and mouse tests.

- [ ] **Step 9: Commit**

```bash
git add src/terminal/
git commit -m "feat: add terminal primitives (ansi, colors, mouse, input, terminal)"
```

---

### Task 4: Tmux IPC Layer

**Files:**

- Create: `src/tmux/ipc.ts`
- Create: `src/tmux/sessions.ts`
- Create: `src/tmux/send.ts`
- Create: `src/tmux/ports.ts`
- Create: `src/tmux/sessions.test.ts`
- Create: `src/tmux/send.test.ts`

- [ ] **Step 1: Create ipc.ts — tmux command wrapper**

```typescript
export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function tmux(args: string[]): TmuxResult {
  const proc = Bun.spawnSync({
    cmd: ['tmux', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export function tmuxOrNull(args: string[]): string | null {
  const result = tmux(args);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

export function tmuxOrThrow(args: string[], label: string): string {
  const result = tmux(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0 ? `${label}: ${detail}` : label);
  }
  return result.stdout;
}
```

- [ ] **Step 2: Create sessions.ts — pane listing and metadata**

```typescript
import { tmux, tmuxOrNull, tmuxOrThrow } from './ipc.ts';

export interface PaneInfo {
  paneId: string;
  paneNum: number;
  sessionName: string;
  windowName: string;
  currentPath: string;
  panePid: number;
}

const PANE_FORMAT = '#{pane_id}\t#{session_name}\t#{window_name}\t#{pane_current_path}\t#{pane_pid}';

export function listPanes(): PaneInfo[] {
  const result = tmux(['list-panes', '-a', '-F', PANE_FORMAT]);
  if (result.exitCode !== 0) return [];

  const panes: PaneInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const paneId = parts[0]!;
    panes.push({
      paneId,
      paneNum: parseInt(paneId.replace('%', ''), 10),
      sessionName: parts[1]!,
      windowName: parts[2]!,
      currentPath: parts[3]!,
      panePid: parseInt(parts[4]!, 10),
    });
  }
  return panes;
}

export function capturePane(paneId: string, maxLines: number): string[] {
  const output = tmuxOrThrow(['capture-pane', '-e', '-p', '-t', paneId], 'capture-pane failed');
  const lines = output.split('\n').map((line) => line.replace(/[\s ]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const start = Math.max(0, lines.length - maxLines);
  return lines.slice(start);
}

export function currentSessionName(): string | null {
  return tmuxOrNull(['display-message', '-p', '#S']);
}

export function currentPaneId(): string | null {
  return tmuxOrNull(['display-message', '-p', '#{pane_id}']);
}

export function switchClient(target: string): void {
  tmuxOrThrow(['switch-client', '-t', target], `switch-client failed for '${target}'`);
}

export function displayMessage(msg: string, durationMs: number = 3000): void {
  tmux(['display-message', '-d', String(durationMs), msg]);
}

export function gitBranch(path: string): string | null {
  const proc = Bun.spawnSync({
    cmd: ['git', '-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const branch = proc.stdout.toString().trim();
  return branch.length > 0 ? branch : null;
}
```

- [ ] **Step 3: Write failing test for sessions parsing**

Create `src/tmux/sessions.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { listPanes } from './sessions.ts';

describe('listPanes', () => {
  test('returns empty array when not in tmux', () => {
    // In CI / non-tmux environments, should gracefully return []
    // This is an integration test — it either returns panes or []
    const panes = listPanes();
    expect(Array.isArray(panes)).toBe(true);
  });
});
```

- [ ] **Step 4: Create send.ts — send-keys with multi-line support**

```typescript
import { tmuxOrThrow } from './ipc.ts';

export function sendKeys(paneId: string, text: string): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) {
      tmuxOrThrow(['send-keys', '-t', paneId, 'M-Enter'], 'send-keys M-Enter failed');
    }
    tmuxOrThrow(['send-keys', '-t', paneId, '-l', line], 'send-keys failed');
  }
  tmuxOrThrow(['send-keys', '-t', paneId, 'Enter'], 'send-keys Enter failed');
}
```

- [ ] **Step 5: Create send.test.ts**

```typescript
import { describe, expect, test } from 'bun:test';
import { sendKeys } from './send.ts';

describe('sendKeys', () => {
  test('function is exported', () => {
    expect(typeof sendKeys).toBe('function');
  });
});
```

- [ ] **Step 6: Create ports.ts — listening port detection**

```typescript
import { tmux } from './ipc.ts';

export interface PanePort {
  paneId: string;
  port: number;
}

export function detectPorts(): PanePort[] {
  const paneResult = tmux(['list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}']);
  if (paneResult.exitCode !== 0) return [];

  const panePids = new Map<number, string>();
  for (const line of paneResult.stdout.split('\n')) {
    if (line.length === 0) continue;
    const [paneId, pidStr] = line.split(':');
    if (paneId && pidStr) {
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) panePids.set(pid, paneId);
    }
  }

  if (panePids.size === 0) return [];

  const proc = Bun.spawnSync({
    cmd: ['lsof', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return [];

  const results: PanePort[] = [];
  let currentPid = -1;

  for (const line of proc.stdout.toString().split('\n')) {
    if (line.startsWith('p')) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith('n') && currentPid > 0) {
      const match = line.match(/:(\d+)$/);
      if (match) {
        const port = parseInt(match[1]!, 10);
        if (port >= 1024) {
          const paneId = findPaneForPid(currentPid, panePids);
          if (paneId) {
            results.push({ paneId, port });
          }
        }
      }
    }
  }

  return results;
}

function findPaneForPid(pid: number, panePids: Map<number, string>): string | null {
  let checkPid = pid;
  const visited = new Set<number>();
  while (checkPid > 1 && !visited.has(checkPid)) {
    visited.add(checkPid);
    const paneId = panePids.get(checkPid);
    if (paneId) return paneId;
    const proc = Bun.spawnSync({
      cmd: ['ps', '-o', 'ppid=', '-p', String(checkPid)],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) break;
    const ppid = parseInt(proc.stdout.toString().trim(), 10);
    if (Number.isNaN(ppid) || ppid <= 1) break;
    checkPid = ppid;
  }
  return null;
}
```

- [ ] **Step 7: Run tests**

```bash
bun test src/tmux/
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/tmux/
git commit -m "feat: add tmux IPC layer (sessions, send-keys, port detection)"
```

---

### Task 5: Agent Configuration

**Files:**

- Create: `src/agents/config.ts`
- Create: `src/agents/registry.ts`
- Create: `src/agents/config.test.ts`

- [ ] **Step 1: Write failing test for config loading**

Create `src/agents/config.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { loadAgentDirs } from './config.ts';

describe('loadAgentDirs', () => {
  test('returns at least one directory in fallback mode', () => {
    // Falls back to ~/.cache/claude-status if no config exists
    const dirs = loadAgentDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/agents/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement config.ts**

```typescript
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentDir {
  name: string;
  statusDir: string;
}

const HOME = homedir();

export function loadAgentDirs(): AgentDir[] {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(HOME, '.config');

  // New format: ~/.config/fleet/agents.json
  const newConfig = join(configDir, 'fleet', 'agents.json');
  if (existsSync(newConfig)) {
    try {
      const data = JSON.parse(readFileSync(newConfig, 'utf-8')) as { agents?: AgentDir[] };
      if (data.agents && Array.isArray(data.agents)) {
        return data.agents.map((a) => ({
          name: a.name,
          statusDir: a.statusDir.replace(/^~/, HOME),
        }));
      }
    } catch {
      // Fall through to legacy
    }
  }

  // Legacy format: ~/.config/agent-status/agents.conf
  const legacyConfig = join(configDir, 'agent-status', 'agents.conf');
  if (existsSync(legacyConfig)) {
    const dirs: AgentDir[] = [];
    const content = readFileSync(legacyConfig, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.length === 0) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      const dir = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^\$HOME/, HOME);
      dirs.push({ name, statusDir: dir });
    }
    if (dirs.length > 0) return dirs;
  }

  // Hardcoded fallback
  const fallback: AgentDir[] = [];
  const claudeDir = join(HOME, '.cache', 'claude-status');
  if (existsSync(claudeDir)) fallback.push({ name: 'claude', statusDir: claudeDir });
  const piDir = join(HOME, '.cache', 'pi-status');
  if (existsSync(piDir)) fallback.push({ name: 'pi', statusDir: piDir });

  return fallback;
}

export function cacheDir(): string {
  return process.env.XDG_CACHE_HOME ?? join(HOME, '.cache');
}

export function fleetCacheDir(): string {
  return join(cacheDir(), 'fleet');
}
```

- [ ] **Step 4: Implement registry.ts**

```typescript
import { loadAgentDirs, type AgentDir } from './config.ts';

export class AgentRegistry {
  private dirs: AgentDir[];

  constructor() {
    this.dirs = loadAgentDirs();
  }

  all(): AgentDir[] {
    return this.dirs;
  }

  statusDirs(): string[] {
    return this.dirs.map((d) => d.statusDir);
  }

  nameForDir(dir: string): string | null {
    return this.dirs.find((d) => d.statusDir === dir)?.name ?? null;
  }

  reload(): void {
    this.dirs = loadAgentDirs();
  }
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/agents/
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/
git commit -m "feat: add agent config with legacy backward compatibility"
```

---

### Task 6: State Engine — Layer 1 (Hook Status Files)

**Files:**

- Create: `src/state/hooks.ts`
- Create: `src/state/hooks.test.ts`
- Create: `test/fixtures/` (sample status files)

- [ ] **Step 1: Create test fixtures**

Create `test/fixtures/sample-status.json`:

```json
{ "state": "working", "pane": "%42", "session": "dotfiles", "tool": "Edit", "ts": 1748380000, "tmux_pid": 12345 }
```

Create `test/fixtures/waiting-status.json`:

```json
{ "state": "waiting", "pane": "%43", "session": "workos-app", "tool": "", "ts": 1748380100, "tmux_pid": 12345 }
```

- [ ] **Step 2: Write failing test for hook status reading**

Create `src/state/hooks.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseStatusFile, readStatusDir } from './hooks.ts';
import { join } from 'node:path';

describe('parseStatusFile', () => {
  test('parses valid status JSON', () => {
    const content =
      '{"state":"working","pane":"%42","session":"dotfiles","tool":"Edit","ts":1748380000,"tmux_pid":12345}';
    const status = parseStatusFile(content);
    expect(status).not.toBeNull();
    expect(status!.state).toBe('working');
    expect(status!.pane).toBe('%42');
    expect(status!.session).toBe('dotfiles');
    expect(status!.tool).toBe('Edit');
  });

  test('returns null for invalid JSON', () => {
    expect(parseStatusFile('not json')).toBeNull();
    expect(parseStatusFile('')).toBeNull();
  });
});

describe('readStatusDir', () => {
  test('reads fixtures directory', () => {
    const fixturesDir = join(import.meta.dir, '../../test/fixtures');
    const statuses = readStatusDir(fixturesDir);
    expect(statuses.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/state/hooks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement hooks.ts**

```typescript
import { readdirSync, readFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { HookStatus } from './types.ts';

export function parseStatusFile(content: string): HookStatus | null {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return {
      state: String(data.state ?? 'idle'),
      pane: String(data.pane ?? ''),
      session: String(data.session ?? ''),
      tool: String(data.tool ?? ''),
      ts: Number(data.ts ?? 0),
      tmux_pid: Number(data.tmux_pid ?? 0),
    };
  } catch {
    return null;
  }
}

export function readStatusDir(dir: string): HookStatus[] {
  if (!existsSync(dir)) return [];
  const statuses: HookStatus[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const status = parseStatusFile(content);
        if (status) statuses.push(status);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Dir listing failed
  }
  return statuses;
}

export function readAllStatusDirs(dirs: string[]): HookStatus[] {
  const all: HookStatus[] = [];
  for (const dir of dirs) {
    all.push(...readStatusDir(dir));
  }
  return all;
}

export type StatusChangeCallback = () => void;

export function watchStatusDirs(dirs: string[], onChange: StatusChangeCallback): () => void {
  const watchers: ReturnType<typeof watch>[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && (filename.endsWith('.status') || filename.endsWith('.jsonl'))) {
          onChange();
        }
      });
      watchers.push(watcher);
    } catch {
      // Skip unwatchable dirs
    }
  }
  return () => {
    for (const w of watchers) w.close();
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/state/hooks.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/hooks.ts src/state/hooks.test.ts test/fixtures/
git commit -m "feat: add hook status file reader with file watcher"
```

---

### Task 7: State Engine — Layer 2 (JSONL Event Stream)

**Files:**

- Create: `src/state/events.ts`
- Create: `src/state/events.test.ts`
- Create: `test/fixtures/sample-events.jsonl`

- [ ] **Step 1: Create JSONL fixture**

Create `test/fixtures/sample-events.jsonl`:

```
{"event":"PreToolUse","ts":1748380000,"tool":"Edit"}
{"event":"Stop","ts":1748380005,"stop_reason":"tool_use"}
{"event":"PreToolUse","ts":1748380006,"tool":"Bash"}
{"event":"Stop","ts":1748380010,"stop_reason":"end_turn"}
```

- [ ] **Step 2: Write failing test**

Create `src/state/events.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseEventLog, deriveStatusFromEvents } from './events.ts';
import { AgentStatus } from './types.ts';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

describe('parseEventLog', () => {
  test('parses JSONL file', () => {
    const content = readFileSync(join(import.meta.dir, '../../test/fixtures/sample-events.jsonl'), 'utf-8');
    const events = parseEventLog(content);
    expect(events.length).toBe(4);
    expect(events[0]!.event).toBe('PreToolUse');
    expect(events[3]!.stop_reason).toBe('end_turn');
  });

  test('skips malformed lines', () => {
    const events = parseEventLog('{"event":"PreToolUse","ts":1}\nnot json\n{"event":"Stop","ts":2}');
    expect(events.length).toBe(2);
  });
});

describe('deriveStatusFromEvents', () => {
  test('tool_use stop_reason means BUSY', () => {
    const events = parseEventLog('{"event":"Stop","ts":1748380005,"stop_reason":"tool_use"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.BUSY);
  });

  test('end_turn stop_reason means DONE', () => {
    const events = parseEventLog('{"event":"Stop","ts":1748380010,"stop_reason":"end_turn"}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.DONE);
  });

  test('background_tasks suppresses DONE', () => {
    const events = parseEventLog('{"event":"Stop","ts":1748380010,"stop_reason":"end_turn","background_tasks":true}');
    expect(deriveStatusFromEvents(events)).toBe(AgentStatus.BUSY);
  });

  test('empty events returns null', () => {
    expect(deriveStatusFromEvents([])).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/state/events.test.ts
```

Expected: FAIL

- [ ] **Step 4: Implement events.ts**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { AgentStatus, type EventEntry } from './types.ts';

export function parseEventLog(content: string): EventEntry[] {
  const entries: EventEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        event: String(data.event ?? ''),
        ts: Number(data.ts ?? 0),
        tool: data.tool != null ? String(data.tool) : undefined,
        stop_reason: data.stop_reason != null ? String(data.stop_reason) : undefined,
        background_tasks: data.background_tasks === true ? true : undefined,
        notification_type: data.notification_type != null ? String(data.notification_type) : undefined,
      });
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

export function readEventLog(path: string): EventEntry[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, 'utf-8');
    return parseEventLog(content);
  } catch {
    return [];
  }
}

export function deriveStatusFromEvents(events: EventEntry[]): AgentStatus | null {
  if (events.length === 0) return null;

  const last = events[events.length - 1]!;

  if (last.event === 'Stop' || last.event === 'SubagentStop') {
    if (last.background_tasks) return AgentStatus.BUSY;
    if (last.stop_reason === 'tool_use') return AgentStatus.BUSY;
    return AgentStatus.DONE;
  }

  if (last.event === 'PreToolUse') return AgentStatus.BUSY;

  if (last.event === 'Notification') {
    switch (last.notification_type) {
      case 'permission_prompt':
        return AgentStatus.PERMIT;
      case 'elicitation_dialog':
        return AgentStatus.QUESTION;
      case 'idle_prompt':
        return AgentStatus.DONE;
    }
  }

  return null;
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/state/events.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/events.ts src/state/events.test.ts test/fixtures/sample-events.jsonl
git commit -m "feat: add JSONL event log parser with status derivation"
```

---

### Task 8: State Engine — Layer 3 (Pane Scraping)

**Files:**

- Create: `src/state/scraper.ts`
- Create: `src/state/scraper.test.ts`

- [ ] **Step 1: Write failing test for pane scraping patterns**

Create `src/state/scraper.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { detectFromPaneContent } from './scraper.ts';
import { AgentStatus } from './types.ts';

describe('detectFromPaneContent', () => {
  test('detects permission prompt', () => {
    const lines = ['Some output...', '', 'Allow Edit to /path/file.ts?', '[y/n]'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects Y/n style permission', () => {
    const lines = ['Allow Read to /path?', '[Y/n]'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects Enter to select pattern', () => {
    const lines = ['Enter to select  ↑/↓  Esc to cancel  Tab to amend'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.PERMIT);
  });

  test('detects working spinner', () => {
    const lines = ['✶ Thinking…', '', '❯'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.BUSY);
  });

  test('detects idle prompt', () => {
    const lines = ['Done! Created the file.', '', '❯'];
    expect(detectFromPaneContent(lines)).toBe(AgentStatus.DONE);
  });

  test('returns null for unrecognized content', () => {
    const lines = ['$ ls', 'file1.ts', 'file2.ts'];
    expect(detectFromPaneContent(lines)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/state/scraper.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement scraper.ts**

```typescript
import { AgentStatus } from './types.ts';
import { capturePane } from '../tmux/sessions.ts';

export function detectFromPaneContent(lines: string[]): AgentStatus | null {
  const bottom = lines.slice(-15);
  const bottomText = bottom.join('\n');

  // Permission prompts
  if (/\[y\/n\]|\[Y\/n\]/i.test(bottomText)) return AgentStatus.PERMIT;
  if (/Do you want to (proceed|allow)/.test(bottomText)) return AgentStatus.PERMIT;
  if (/Enter to select.*[↑↓]|Esc to cancel.*Tab to amend/.test(bottomText)) return AgentStatus.PERMIT;

  // Find the prompt marker (❯)
  let promptLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('❯')) {
      promptLine = i;
      break;
    }
  }

  if (promptLine === -1) return null;

  // Check for working indicators above the prompt
  const start = Math.max(0, promptLine - 10);
  const above = lines.slice(start, promptLine);
  const aboveText = above.join('\n');

  if (/^[✢✶·⏳⏺●] \S+…|Running…/m.test(aboveText)) {
    return AgentStatus.BUSY;
  }

  return AgentStatus.DONE;
}

export function scrapePane(paneId: string): AgentStatus | null {
  try {
    const lines = capturePane(paneId, 30);
    return detectFromPaneContent(lines);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/state/scraper.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/scraper.ts src/state/scraper.test.ts
git commit -m "feat: add pane scraping for visual state detection"
```

---

### Task 9: State Engine — Fuser

**Files:**

- Create: `src/state/engine.ts`
- Create: `src/state/engine.test.ts`

- [ ] **Step 1: Write failing test for state fusion**

Create `src/state/engine.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { fuseState, StateEngine } from './engine.ts';
import { AgentStatus } from './types.ts';

describe('fuseState', () => {
  const now = Math.floor(Date.now() / 1000);

  test('hook state with fresh timestamp wins', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('freshness invariant rejects stale hook data', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now - 100,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.DONE,
      currentTs: now - 5,
    });
    expect(result).toBe(AgentStatus.DONE);
  });

  test('event layer overrides hook when more specific', () => {
    const result = fuseState({
      hookState: 'completed',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: null,
      currentStatus: AgentStatus.IDLE,
      currentTs: now - 10,
    });
    expect(result).toBe(AgentStatus.BUSY);
  });

  test('scrape layer used as tiebreaker', () => {
    const result = fuseState({
      hookState: 'working',
      hookTs: now,
      eventStatus: AgentStatus.BUSY,
      scrapeStatus: AgentStatus.PERMIT,
      currentStatus: AgentStatus.BUSY,
      currentTs: now - 5,
    });
    expect(result).toBe(AgentStatus.PERMIT);
  });

  test('DONE decays to IDLE after 60s', () => {
    const result = fuseState({
      hookState: 'completed',
      hookTs: now - 65,
      eventStatus: null,
      scrapeStatus: null,
      currentStatus: AgentStatus.DONE,
      currentTs: now - 65,
    });
    expect(result).toBe(AgentStatus.IDLE);
  });

  test('maps notification waiting to PERMIT/QUESTION/DONE', () => {
    expect(
      fuseState({
        hookState: 'waiting',
        hookTs: now,
        eventStatus: null,
        scrapeStatus: null,
        currentStatus: AgentStatus.IDLE,
        currentTs: now - 10,
      }),
    ).toBe(AgentStatus.PERMIT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/state/engine.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement engine.ts**

```typescript
import { AgentStatus, type AgentState, type HookStatus } from './types.ts';
import { readAllStatusDirs, watchStatusDirs, type StatusChangeCallback } from './hooks.ts';
import { readEventLog, deriveStatusFromEvents } from './events.ts';
import { scrapePane } from './scraper.ts';
import { listPanes, type PaneInfo } from '../tmux/sessions.ts';
import { gitBranch } from '../tmux/sessions.ts';
import { detectPorts } from '../tmux/ports.ts';
import { join } from 'node:path';

const DONE_DECAY_SECS = 60;
const WORKING_TIMEOUT_SECS = 180;

export interface FuseInput {
  hookState: string;
  hookTs: number;
  eventStatus: AgentStatus | null;
  scrapeStatus: AgentStatus | null;
  currentStatus: AgentStatus;
  currentTs: number;
}

function mapHookState(state: string): AgentStatus {
  switch (state) {
    case 'waiting':
      return AgentStatus.PERMIT;
    case 'working':
      return AgentStatus.BUSY;
    case 'completed':
      return AgentStatus.DONE;
    default:
      return AgentStatus.IDLE;
  }
}

export function fuseState(input: FuseInput): AgentStatus {
  const now = Math.floor(Date.now() / 1000);

  // Freshness invariant: reject stale hook data
  if (input.hookTs <= input.currentTs && input.currentStatus !== AgentStatus.IDLE) {
    // Check decay on current state
    const age = now - input.currentTs;
    if (input.currentStatus === AgentStatus.DONE && age >= DONE_DECAY_SECS) {
      return AgentStatus.IDLE;
    }
    if (input.currentStatus === AgentStatus.BUSY && age >= WORKING_TIMEOUT_SECS) {
      return AgentStatus.IDLE;
    }
    return input.currentStatus;
  }

  // Scrape layer is the visual arbiter — PERMIT from scrape always wins
  if (input.scrapeStatus === AgentStatus.PERMIT) {
    return AgentStatus.PERMIT;
  }

  // Event layer is more specific than hook layer (distinguishes tool_use stop from end_turn)
  if (input.eventStatus !== null) {
    return input.eventStatus;
  }

  // Map hook state
  let status = mapHookState(input.hookState);

  // Apply decay
  const hookAge = now - input.hookTs;
  if (status === AgentStatus.DONE && hookAge >= DONE_DECAY_SECS) {
    status = AgentStatus.IDLE;
  }
  if (status === AgentStatus.BUSY && hookAge >= WORKING_TIMEOUT_SECS) {
    status = AgentStatus.IDLE;
  }

  return status;
}

export class StateEngine {
  private states: Map<string, AgentState> = new Map();
  private statusDirs: string[];
  private stopWatching: (() => void) | null = null;

  constructor(statusDirs: string[]) {
    this.statusDirs = statusDirs;
  }

  refresh(): AgentState[] {
    const hookStatuses = readAllStatusDirs(this.statusDirs);
    const panes = listPanes();
    const portMap = new Map<string, number[]>();

    try {
      for (const pp of detectPorts()) {
        const existing = portMap.get(pp.paneId) ?? [];
        existing.push(pp.port);
        portMap.set(pp.paneId, existing);
      }
    } catch {
      // Port detection is optional
    }

    const paneMap = new Map<string, PaneInfo>();
    for (const p of panes) paneMap.set(p.paneId, p);

    const hookByPane = new Map<string, HookStatus>();
    for (const h of hookStatuses) {
      hookByPane.set(h.pane, h);
    }

    const newStates: AgentState[] = [];

    for (const pane of panes) {
      const hook = hookByPane.get(pane.paneId);
      const current = this.states.get(pane.paneId);

      let status: AgentStatus;
      let tool: string | null = null;
      let ts = 0;
      let agentType = 'unknown';

      if (hook) {
        // Determine which agent this belongs to
        for (const dir of this.statusDirs) {
          const statusFile = join(dir, `${pane.paneNum}.status`);
          try {
            if (Bun.file(statusFile).size > 0) {
              // Found in this dir — name the agent type
              const dirName = dir.split('/').pop() ?? 'unknown';
              agentType = dirName.replace('-status', '');
              break;
            }
          } catch {
            continue;
          }
        }

        // Read JSONL event log if available
        let eventStatus: AgentStatus | null = null;
        for (const dir of this.statusDirs) {
          const eventsFile = join(dir, `${pane.paneNum}.events.jsonl`);
          const events = readEventLog(eventsFile);
          if (events.length > 0) {
            eventStatus = deriveStatusFromEvents(events);
            break;
          }
        }

        tool = hook.tool || null;
        ts = hook.ts;

        status = fuseState({
          hookState: hook.state,
          hookTs: hook.ts,
          eventStatus,
          scrapeStatus: null,
          currentStatus: current?.status ?? AgentStatus.IDLE,
          currentTs: current?.ts ?? 0,
        });
      } else {
        status = AgentStatus.SHELL;
        ts = Math.floor(Date.now() / 1000);
      }

      const state: AgentState = {
        paneId: pane.paneId,
        paneNum: pane.paneNum,
        session: pane.sessionName,
        status,
        tool,
        project: shortenPath(pane.currentPath),
        branch: gitBranch(pane.currentPath),
        ports: portMap.get(pane.paneId) ?? [],
        ts,
        agentType,
      };

      this.states.set(pane.paneId, state);
      newStates.push(state);
    }

    // Clean up states for panes that no longer exist
    for (const key of this.states.keys()) {
      if (!paneMap.has(key)) {
        this.states.delete(key);
      }
    }

    return newStates;
  }

  startWatching(onChange: StatusChangeCallback): void {
    this.stopWatching = watchStatusDirs(this.statusDirs, onChange);
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }
}

function shortenPath(path: string): string {
  const home = Bun.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/state/engine.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/engine.ts src/state/engine.test.ts
git commit -m "feat: add three-layer state fusion engine"
```

---

### Task 10: Hook Scripts (Plugin Delivery)

**Files:**

- Create: `hooks/hooks.json`
- Create: `hooks/lib.sh`
- Create: `hooks/notification.sh`
- Create: `hooks/pre-tool-use.sh`
- Create: `hooks/stop.sh`
- Create: `hooks/subagent-stop.sh`
- Create: `hooks/session-end.sh`

- [ ] **Step 1: Create hooks.json**

```json
{
  "description": "Fleet agent state tracking",
  "hooks": {
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/notification.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/pre-tool-use.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/stop.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/subagent-stop.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/session-end.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Create hooks/lib.sh**

```bash
#!/usr/bin/env bash
# Fleet hook shared library
# Sources by all hook scripts. Writes status files and appends JSONL events.

FLEET_STATUS_DIR="${HOME}/.cache/claude-status"
mkdir -p "$FLEET_STATUS_DIR"

# Require tmux
[ -z "$TMUX" ] && exit 0

FLEET_PANE_ID="${TMUX_PANE}"
[ -z "$FLEET_PANE_ID" ] && exit 0

FLEET_PANE_NUM="${FLEET_PANE_ID#%}"
FLEET_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
[ -z "$FLEET_SESSION" ] && exit 0

FLEET_TS=$(date +%s)
FLEET_TMUX_PID=$(tmux display-message -p '#{pid}' 2>/dev/null)
FLEET_STATUS_FILE="${FLEET_STATUS_DIR}/${FLEET_PANE_NUM}.status"
FLEET_EVENTS_FILE="${FLEET_STATUS_DIR}/${FLEET_PANE_NUM}.events.jsonl"

fleet_write_status() {
  local state="$1" tool="${2:-}"
  printf '{"state":"%s","pane":"%s","session":"%s","tool":"%s","ts":%s,"tmux_pid":%s}\n' \
    "$state" "$FLEET_PANE_ID" "$FLEET_SESSION" "$tool" "$FLEET_TS" "${FLEET_TMUX_PID:-0}" \
    > "$FLEET_STATUS_FILE"
}

fleet_append_event() {
  local event="$1"
  shift
  local extra=""
  while [ $# -gt 0 ]; do
    extra="${extra},\"$1\":$2"
    shift 2
  done
  printf '{"event":"%s","ts":%s%s}\n' "$event" "$FLEET_TS" "$extra" >> "$FLEET_EVENTS_FILE"
}

fleet_notify() {
  local state="$1" session="$2" pane_id="$3" tool="${4:-}"
  case "$state" in
    waiting|completed) ;;
    *) return ;;
  esac

  local current_pane
  current_pane=$(tmux display-message -p '#{pane_id}' 2>/dev/null)
  [ "$current_pane" = "$pane_id" ] && return

  local current_session
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)

  local icon="⏳"
  [ "$state" = "completed" ] && icon="✓"
  local msg="$icon $session"
  [ -n "$tool" ] && msg="$msg ($tool)"

  tmux display-message -d 3000 "$msg" 2>/dev/null

  if [ "$current_session" != "$session" ]; then
    tmux run-shell -t "$pane_id" "printf '\\a'" 2>/dev/null
  fi
}
```

- [ ] **Step 3: Create hooks/notification.sh**

```bash
#!/usr/bin/env bash
# Fleet notification hook — splits notification types into PERMIT / QUESTION / DONE

INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.type // empty' 2>/dev/null)

case "$NOTIFICATION_TYPE" in
  permission_prompt)
    fleet_write_status "waiting"
    fleet_append_event "Notification" "notification_type" "\"permission_prompt\""
    fleet_notify "waiting" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  elicitation_dialog)
    fleet_write_status "waiting"
    fleet_append_event "Notification" "notification_type" "\"elicitation_dialog\""
    fleet_notify "waiting" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  idle_prompt)
    fleet_write_status "completed"
    fleet_append_event "Notification" "notification_type" "\"idle_prompt\""
    fleet_notify "completed" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  *)
    fleet_append_event "Notification" "notification_type" "\"${NOTIFICATION_TYPE:-unknown}\""
    ;;
esac

exit 0
```

- [ ] **Step 4: Create hooks/pre-tool-use.sh**

```bash
#!/usr/bin/env bash
# Fleet PreToolUse hook → BUSY

INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

fleet_write_status "working" "$TOOL"
fleet_append_event "PreToolUse" "tool" "\"$TOOL\""

exit 0
```

- [ ] **Step 5: Create hooks/stop.sh**

```bash
#!/usr/bin/env bash
# Fleet Stop hook → DONE (with grace period + background task guard)

INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // "end_turn"' 2>/dev/null)
BG_TASKS=$(echo "$INPUT" | jq -r '.background_tasks // false' 2>/dev/null)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

fleet_append_event "Stop" "stop_reason" "\"$STOP_REASON\"" "background_tasks" "$BG_TASKS"

# tool_use stop means another tool is about to run — stay BUSY
if [ "$STOP_REASON" = "tool_use" ]; then
  fleet_write_status "working" "$TOOL"
  exit 0
fi

# Background tasks present — don't mark as done
if [ "$BG_TASKS" = "true" ]; then
  fleet_write_status "working" "$TOOL"
  exit 0
fi

# Grace period: wait 3s, then mark completed (unless overwritten)
(
  sleep 3
  # Only write if file still shows working state from this timestamp
  if [ -f "$FLEET_STATUS_FILE" ]; then
    CURRENT_TS=$(jq -r '.ts // 0' "$FLEET_STATUS_FILE" 2>/dev/null)
    if [ "$CURRENT_TS" = "$FLEET_TS" ]; then
      fleet_write_status "completed" "$TOOL"
      fleet_notify "completed" "$FLEET_SESSION" "$FLEET_PANE_ID" "$TOOL" >/dev/null 2>&1
    fi
  fi
) &

exit 0
```

- [ ] **Step 6: Create hooks/subagent-stop.sh**

```bash
#!/usr/bin/env bash
# Fleet SubagentStop hook → BUSY (subagent done, parent continues)

INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

fleet_append_event "SubagentStop"
# Don't change state — the parent agent is still working

exit 0
```

- [ ] **Step 7: Create hooks/session-end.sh**

```bash
#!/usr/bin/env bash
# Fleet SessionEnd hook — cleanup status file

INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

fleet_append_event "SessionEnd"
rm -f "$FLEET_STATUS_FILE"
rm -f "$FLEET_EVENTS_FILE"

exit 0
```

- [ ] **Step 8: Make scripts executable**

```bash
chmod +x hooks/*.sh
```

- [ ] **Step 9: Commit**

```bash
git add hooks/
git commit -m "feat: add Claude Code hook scripts for state tracking"
```

---

### Task 11: Plugin Manifest

**Files:**

- Create: `plugin.json`

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "fleet",
  "description": "Agent dashboard TUI — tracks AI agent state via hooks for the fleet CLI",
  "version": "0.1.0"
}
```

- [ ] **Step 2: Commit**

```bash
git add plugin.json
git commit -m "feat: add Claude Code plugin manifest"
```

---

### Task 12: CLI — Status Command

**Files:**

- Create: `src/cli/status.ts`
- Create: `src/cli/status.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/cli/status.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { formatTmuxStatus, formatPlainStatus } from './status.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (overrides: Partial<AgentState>): AgentState => ({
  paneId: '%42',
  paneNum: 42,
  session: 'test',
  status: AgentStatus.IDLE,
  tool: null,
  project: '~/Developer/test',
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
  ...overrides,
});

describe('formatPlainStatus', () => {
  test('shows state and count for a session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT }), makeState({ status: AgentStatus.BUSY })];
    const result = formatPlainStatus(states, 'test');
    expect(result).toContain('PERMIT');
  });
});

describe('formatTmuxStatus', () => {
  test('returns tmux format string for waiting session', () => {
    const states = [makeState({ status: AgentStatus.PERMIT })];
    const result = formatTmuxStatus(states, 'test');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('#[');
  });

  test('returns empty for idle session', () => {
    const states = [makeState({ status: AgentStatus.IDLE })];
    const result = formatTmuxStatus(states, 'test');
    expect(result).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/cli/status.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement status.ts**

```typescript
import { AgentStatus, compareStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';

export function formatPlainStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return 'idle 0';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;
  const needsYouCount = sessionStates.filter(
    (s) => s.status === AgentStatus.PERMIT || s.status === AgentStatus.QUESTION || s.status === AgentStatus.DONE,
  ).length;

  return `${mostUrgent} ${needsYouCount}`;
}

export function formatTmuxStatus(states: AgentState[], session: string): string {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) return '';

  sessionStates.sort((a, b) => compareStatus(a.status, b.status));
  const mostUrgent = sessionStates[0]!.status;

  // Only show when agents need attention
  const needsAttention = [AgentStatus.PERMIT, AgentStatus.QUESTION, AgentStatus.DONE];
  if (!needsAttention.includes(mostUrgent)) return '';

  const display = STATUS_DISPLAY[mostUrgent];
  return `#[fg=${display.color}] ${display.icon} `;
}

export function runStatus(args: string[], states: AgentState[]): string {
  const tmuxMode = args.includes('--tmux');
  const session = args.filter((a) => !a.startsWith('--'))[0] ?? '';

  if (tmuxMode) {
    return formatTmuxStatus(states, session);
  }
  return formatPlainStatus(states, session);
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/cli/status.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/status.ts src/cli/status.test.ts
git commit -m "feat: add fleet status command with tmux format output"
```

---

### Task 13: CLI — Next, Send, Doctor, Reconcile, Install

**Files:**

- Create: `src/cli/next.ts`
- Create: `src/cli/send.ts`
- Create: `src/cli/install.ts`
- Create: `src/cli/doctor.ts`
- Create: `src/cli/reconcile.ts`

- [ ] **Step 1: Implement next.ts**

```typescript
import { AgentStatus, compareStatus, type AgentState } from '../state/types.ts';
import { switchClient, displayMessage, currentPaneId } from '../tmux/sessions.ts';

export function runNext(states: AgentState[]): number {
  const currentPane = currentPaneId();
  const waiting = states
    .filter(
      (s) => s.status === AgentStatus.PERMIT || s.status === AgentStatus.QUESTION || s.status === AgentStatus.DONE,
    )
    .sort((a, b) => compareStatus(a.status, b.status));

  if (waiting.length === 0) {
    displayMessage('No waiting agents');
    return 0;
  }

  // Cycle: find next pane after current
  let target = waiting[0]!;
  if (currentPane) {
    const currentIdx = waiting.findIndex((s) => s.paneId === currentPane);
    if (currentIdx >= 0) {
      target = waiting[(currentIdx + 1) % waiting.length]!;
    }
  }

  try {
    switchClient(target.paneId);
    return 0;
  } catch {
    displayMessage(`Failed to switch to ${target.paneId}`);
    return 1;
  }
}
```

- [ ] **Step 2: Implement send.ts (CLI version)**

```typescript
import { AgentStatus, type AgentState } from '../state/types.ts';
import { sendKeys } from '../tmux/send.ts';

export function runSend(session: string, prompt: string, states: AgentState[], force: boolean): number {
  const sessionStates = states.filter((s) => s.session === session);
  if (sessionStates.length === 0) {
    process.stderr.write(`No agents found in session '${session}'\n`);
    return 1;
  }

  const target = sessionStates[0]!;

  // State gating
  switch (target.status) {
    case AgentStatus.PERMIT:
      process.stderr.write(`Session '${session}' has a permission prompt — refusing to send\n`);
      return 1;
    case AgentStatus.QUESTION:
      process.stderr.write(`Session '${session}' is asking a question — refusing to send\n`);
      return 1;
    case AgentStatus.BUSY:
      if (!force) {
        process.stderr.write(`Session '${session}' is busy — use --force to override\n`);
        return 1;
      }
      break;
    case AgentStatus.DONE:
    case AgentStatus.IDLE:
    case AgentStatus.SHELL:
      break;
    case AgentStatus.DOWN:
      process.stderr.write(`Session '${session}' has no live process\n`);
      return 1;
  }

  try {
    sendKeys(target.paneId, prompt);
    return 0;
  } catch (err) {
    process.stderr.write(`Failed to send: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
```

- [ ] **Step 3: Implement install.ts**

```typescript
export function runInstall(): number {
  const pluginDir = import.meta.dir.replace(/\/src\/cli$/, '');
  const proc = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'install', pluginDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exitCode ?? 1;
}

export function runUninstall(): number {
  const pluginDir = import.meta.dir.replace(/\/src\/cli$/, '');
  const proc = Bun.spawnSync({
    cmd: ['claude', 'plugin', 'uninstall', pluginDir],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exitCode ?? 1;
}
```

- [ ] **Step 4: Implement doctor.ts**

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmux } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDoctor(): number {
  const checks: Check[] = [];

  // tmux available
  const tmuxResult = tmux(['display-message', '-p', '#{version}']);
  checks.push({
    name: 'tmux',
    ok: tmuxResult.exitCode === 0,
    detail: tmuxResult.exitCode === 0 ? `v${tmuxResult.stdout.trim()}` : 'not running',
  });

  // Plugin installed
  const home = homedir();
  const pluginDir = join(home, '.claude', 'plugins');
  const pluginInstalled = existsSync(pluginDir);
  checks.push({
    name: 'plugin directory',
    ok: pluginInstalled,
    detail: pluginInstalled ? pluginDir : 'not found',
  });

  // Status directories writable
  const dirs = loadAgentDirs();
  for (const dir of dirs) {
    const writable = existsSync(dir.statusDir);
    checks.push({
      name: `${dir.name} status dir`,
      ok: writable,
      detail: writable ? dir.statusDir : `${dir.statusDir} (missing)`,
    });
  }

  // hooks.json exists
  const hooksJson = join(import.meta.dir, '../../hooks/hooks.json');
  const hooksExist = existsSync(hooksJson);
  checks.push({
    name: 'hooks.json',
    ok: hooksExist,
    detail: hooksExist ? 'found' : 'missing',
  });

  // Output
  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? '✓' : '✗';
    const color = check.ok ? '\x1b[32m' : '\x1b[31m';
    process.stdout.write(`${color}${icon}\x1b[0m ${check.name}: ${check.detail}\n`);
    if (!check.ok) allOk = false;
  }

  return allOk ? 0 : 1;
}
```

- [ ] **Step 5: Implement reconcile.ts**

```typescript
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmux } from '../tmux/ipc.ts';
import { loadAgentDirs } from '../agents/config.ts';
import { parseStatusFile } from '../state/hooks.ts';

export function runReconcile(dryRun: boolean, verbose: boolean): number {
  const dirs = loadAgentDirs();
  let removed = 0;
  let fixed = 0;
  const now = Math.floor(Date.now() / 1000);

  const log = (msg: string) => {
    if (verbose) process.stdout.write(`${msg}\n`);
  };

  for (const dir of dirs) {
    if (!existsSync(dir.statusDir)) continue;
    const files = readdirSync(dir.statusDir);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      const path = join(dir.statusDir, file);
      let content: string;
      try {
        content = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }

      const status = parseStatusFile(content);
      if (!status) {
        log(`CORRUPT: ${path}`);
        if (!dryRun) rmSync(path, { force: true });
        removed++;
        continue;
      }

      // Verify pane exists
      if (status.pane) {
        const check = tmux(['display-message', '-t', status.pane, '-p', '#{pane_id}']);
        if (check.exitCode !== 0 || check.stdout.trim() === '') {
          log(`ORPHAN: ${path} (pane ${status.pane} dead)`);
          if (!dryRun) rmSync(path, { force: true });
          removed++;
          continue;
        }
      }

      // Fix stale working state
      if (status.state === 'working' && status.ts > 0) {
        const age = now - status.ts;
        if (age >= 180) {
          log(`STALE: ${path} (working for ${age}s)`);
          if (!dryRun) {
            const data = JSON.parse(content) as Record<string, unknown>;
            data.state = 'idle';
            writeFileSync(path, JSON.stringify(data) + '\n');
          }
          fixed++;
        }
      }
    }
  }

  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(`${prefix}Reconcile complete: ${removed} orphans removed, ${fixed} stale fixed\n`);
  return 0;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/
git commit -m "feat: add CLI commands (next, send, install, doctor, reconcile)"
```

---

### Task 14: TUI — App State Model

**Files:**

- Create: `src/tui/app.ts`
- Create: `src/tui/app.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tui/app.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { TuiApp, TuiMode } from './app.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';

const makeState = (session: string, status: AgentStatus): AgentState => ({
  paneId: `%${Math.floor(Math.random() * 100)}`,
  paneNum: Math.floor(Math.random() * 100),
  session,
  status,
  tool: null,
  project: `~/Developer/${session}`,
  branch: 'main',
  ports: [],
  ts: Math.floor(Date.now() / 1000),
  agentType: 'claude',
});

describe('TuiApp', () => {
  test('sorts sessions by priority', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('idle-session', AgentStatus.IDLE),
      makeState('permit-session', AgentStatus.PERMIT),
      makeState('busy-session', AgentStatus.BUSY),
    ]);
    const sorted = app.sortedStates();
    expect(sorted[0]!.session).toBe('permit-session');
    expect(sorted[1]!.session).toBe('busy-session');
    expect(sorted[2]!.session).toBe('idle-session');
  });

  test('filter narrows visible sessions', () => {
    const app = new TuiApp();
    app.updateStates([makeState('dotfiles', AgentStatus.IDLE), makeState('workos-app', AgentStatus.BUSY)]);
    app.setFilter('dot');
    const visible = app.visibleStates();
    expect(visible.length).toBe(1);
    expect(visible[0]!.session).toBe('dotfiles');
  });

  test('mode transitions', () => {
    const app = new TuiApp();
    expect(app.mode).toBe(TuiMode.DASHBOARD);
    app.mode = TuiMode.PREVIEW;
    expect(app.mode).toBe(TuiMode.PREVIEW);
    app.mode = TuiMode.SEND;
    expect(app.mode).toBe(TuiMode.SEND);
  });

  test('selection clamps to range', () => {
    const app = new TuiApp();
    app.updateStates([makeState('a', AgentStatus.IDLE)]);
    app.selectedIndex = 5;
    expect(app.selectedState()).not.toBeNull();
  });

  test('summary counts states', () => {
    const app = new TuiApp();
    app.updateStates([
      makeState('a', AgentStatus.PERMIT),
      makeState('b', AgentStatus.QUESTION),
      makeState('c', AgentStatus.DONE),
      makeState('d', AgentStatus.BUSY),
    ]);
    const summary = app.summary();
    expect(summary.total).toBe(4);
    expect(summary.permit).toBe(1);
    expect(summary.question).toBe(1);
    expect(summary.done).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/tui/app.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement app.ts**

```typescript
import { AgentStatus, compareStatus, type AgentState } from '../state/types.ts';

export const TuiMode = {
  DASHBOARD: 'DASHBOARD',
  PREVIEW: 'PREVIEW',
  SEND: 'SEND',
  HELP: 'HELP',
} as const;

export type TuiMode = (typeof TuiMode)[keyof typeof TuiMode];

export interface Summary {
  total: number;
  permit: number;
  question: number;
  done: number;
  busy: number;
}

export class TuiApp {
  private states: AgentState[] = [];
  private filter: string = '';
  selectedIndex: number = 0;
  mode: TuiMode = TuiMode.DASHBOARD;
  sendBuffer: string = '';
  shouldQuit: boolean = false;

  updateStates(newStates: AgentState[]): void {
    const selectedPaneId = this.selectedState()?.paneId ?? null;
    this.states = newStates;

    if (selectedPaneId) {
      const sorted = this.sortedStates();
      const visible = this.applyFilter(sorted);
      const newIdx = visible.findIndex((s) => s.paneId === selectedPaneId);
      if (newIdx >= 0) {
        this.selectedIndex = newIdx;
        return;
      }
    }
    this.clampSelection();
  }

  sortedStates(): AgentState[] {
    return [...this.states].sort((a, b) => {
      const cmp = compareStatus(a.status, b.status);
      if (cmp !== 0) return cmp;
      return a.session.localeCompare(b.session);
    });
  }

  visibleStates(): AgentState[] {
    return this.applyFilter(this.sortedStates());
  }

  private applyFilter(states: AgentState[]): AgentState[] {
    if (this.filter.length === 0) return states;
    const lower = this.filter.toLowerCase();
    return states.filter(
      (s) => s.session.toLowerCase().includes(lower) || (s.project?.toLowerCase().includes(lower) ?? false),
    );
  }

  selectedState(): AgentState | null {
    const visible = this.visibleStates();
    if (visible.length === 0) return null;
    const idx = Math.min(this.selectedIndex, visible.length - 1);
    return visible[idx] ?? null;
  }

  setFilter(text: string): void {
    this.filter = text;
    this.selectedIndex = 0;
  }

  getFilter(): string {
    return this.filter;
  }

  clearFilter(): void {
    this.filter = '';
    this.selectedIndex = 0;
  }

  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  moveDown(): void {
    const max = this.visibleStates().length - 1;
    if (this.selectedIndex < max) this.selectedIndex++;
  }

  summary(): Summary {
    return {
      total: this.states.length,
      permit: this.states.filter((s) => s.status === AgentStatus.PERMIT).length,
      question: this.states.filter((s) => s.status === AgentStatus.QUESTION).length,
      done: this.states.filter((s) => s.status === AgentStatus.DONE).length,
      busy: this.states.filter((s) => s.status === AgentStatus.BUSY).length,
    };
  }

  private clampSelection(): void {
    const max = Math.max(0, this.visibleStates().length - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/tui/app.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/app.ts src/tui/app.test.ts
git commit -m "feat: add TUI app state model with priority sorting"
```

---

### Task 15: TUI — Dashboard Renderer

**Files:**

- Create: `src/tui/dashboard.ts`
- Create: `src/tui/render.ts`
- Create: `src/tui/help.ts`

- [ ] **Step 1: Implement dashboard.ts**

```typescript
import { C } from '../terminal/colors.ts';
import { truncateAnsi, visibleLength } from '../terminal/ansi.ts';
import { AgentStatus, STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import type { TuiApp } from './app.ts';

export function renderHeader(app: TuiApp, cols: number): string {
  const s = app.summary();
  const parts: string[] = [`${C.bold}fleet${C.reset}`];
  parts.push(`  ${C.gray}${s.total} agents${C.reset}`);
  if (s.permit > 0) parts.push(`  ${C.permit}${s.permit} permit${C.reset}`);
  if (s.question > 0) parts.push(`  ${C.question}${s.question} question${C.reset}`);
  if (s.done > 0) parts.push(`  ${C.done}${s.done} done${C.reset}`);
  return truncateAnsi(parts.join(''), cols);
}

export function renderSessionList(app: TuiApp, startRow: number, maxRows: number, cols: number): string[] {
  const visible = app.visibleStates();
  const lines: string[] = [];

  // Column header
  const header = formatRow('ST', 'SESSION', 'PROJECT', 'BRANCH', 'AGE', cols, true);
  lines.push(header);
  lines.push(`${C.gray}${'─'.repeat(Math.min(cols, 75))}${C.reset}`);

  if (visible.length === 0) {
    lines.push(`${C.gray}  No agents found${C.reset}`);
    return lines;
  }

  const scrollOffset = calculateScroll(app.selectedIndex, maxRows - 2, visible.length);

  for (let i = scrollOffset; i < visible.length && lines.length < maxRows; i++) {
    const state = visible[i]!;
    const selected = i === app.selectedIndex;
    lines.push(formatSessionRow(state, cols, selected));
  }

  return lines;
}

function formatRow(
  st: string,
  session: string,
  project: string,
  branch: string,
  age: string,
  cols: number,
  isHeader: boolean,
): string {
  const stW = 4;
  const sessionW = 17;
  const branchW = 16;
  const ageW = 6;
  const projectW = Math.max(10, cols - stW - sessionW - branchW - ageW - 4);

  const color = isHeader ? C.gray : '';
  const reset = isHeader ? C.reset : '';
  return `${color}  ${pad(st, stW)}${pad(session, sessionW)}${pad(project, projectW)}${pad(branch, branchW)}${pad(age, ageW)}${reset}`;
}

function formatSessionRow(state: AgentState, cols: number, selected: boolean): string {
  const display = STATUS_DISPLAY[state.status];
  const stateColor = getStateColor(state.status);
  const icon = display.icon;

  const age = formatAge(state.ts);
  const project = state.project ?? '';
  const branch = state.branch ?? '—';

  const prefix = selected ? `${C.bold}> ` : '  ';
  const stW = 4;
  const sessionW = 17;
  const branchW = 16;
  const ageW = 6;
  const projectW = Math.max(10, cols - stW - sessionW - branchW - ageW - 4);

  const sessionColor = selected ? C.bold : '';

  return `${prefix}${stateColor}${pad(icon, stW - 2)}${C.reset}${sessionColor}${pad(state.session, sessionW)}${C.reset}${C.gray}${pad(truncate(project, projectW), projectW)}${pad(truncate(branch, branchW), branchW)}${pad(age, ageW)}${C.reset}`;
}

function getStateColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.PERMIT:
      return C.permit;
    case AgentStatus.QUESTION:
      return C.question;
    case AgentStatus.DONE:
      return C.done;
    case AgentStatus.BUSY:
      return C.busy;
    case AgentStatus.IDLE:
      return C.idle;
    case AgentStatus.SHELL:
      return C.shell;
    case AgentStatus.DOWN:
      return C.down;
  }
}

function formatAge(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const secs = Math.max(0, now - ts);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function pad(str: string, width: number): string {
  const visible = str.length;
  if (visible >= width) return str.slice(0, width);
  return str + ' '.repeat(width - visible);
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  return value.slice(0, maxWidth - 1) + '…';
}

function calculateScroll(selected: number, viewHeight: number, total: number): number {
  if (total <= viewHeight) return 0;
  const half = Math.floor(viewHeight / 2);
  if (selected <= half) return 0;
  if (selected >= total - half) return Math.max(0, total - viewHeight);
  return selected - half;
}

export function renderFooter(app: TuiApp, cols: number): string {
  const filter = app.getFilter();
  if (filter.length > 0) {
    return truncateAnsi(`${C.cyan}/${filter}${C.reset} ${C.gray}· esc clear${C.reset}`, cols);
  }
  const hints = `${C.gray}↑↓ navigate  enter switch  / filter  p preview  s send  n next  ? help${C.reset}`;
  return truncateAnsi(hints, cols);
}
```

- [ ] **Step 2: Implement help.ts**

```typescript
import { C } from '../terminal/colors.ts';

export function renderHelp(cols: number, rows: number): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${C.bold}  Fleet — Keybindings${C.reset}`);
  lines.push('');
  lines.push(`  ${C.yellowBold}↑/↓ or j/k${C.reset}${C.gray}  Navigate sessions${C.reset}`);
  lines.push(`  ${C.yellowBold}Enter${C.reset}${C.gray}       Switch to session${C.reset}`);
  lines.push(`  ${C.yellowBold}n${C.reset}${C.gray}           Jump to next waiting agent${C.reset}`);
  lines.push(`  ${C.yellowBold}p${C.reset}${C.gray}           Toggle preview pane${C.reset}`);
  lines.push(`  ${C.yellowBold}s${C.reset}${C.gray}           Send prompt to session${C.reset}`);
  lines.push(`  ${C.yellowBold}/${C.reset}${C.gray}           Filter sessions by name${C.reset}`);
  lines.push(`  ${C.yellowBold}a${C.reset}${C.gray}           Create new agent session${C.reset}`);
  lines.push(`  ${C.yellowBold}x${C.reset}${C.gray}           Kill selected session${C.reset}`);
  lines.push(`  ${C.yellowBold}d${C.reset}${C.gray}           Doctor — inline health check${C.reset}`);
  lines.push(`  ${C.yellowBold}?${C.reset}${C.gray}           This help${C.reset}`);
  lines.push(`  ${C.yellowBold}q or Esc${C.reset}${C.gray}    Quit${C.reset}`);
  lines.push('');
  lines.push(`  ${C.gray}Press any key to close${C.reset}`);
  return lines;
}
```

- [ ] **Step 3: Implement render.ts (composes all views)**

```typescript
import { TuiMode, type TuiApp } from './app.ts';
import { renderHeader, renderSessionList, renderFooter } from './dashboard.ts';
import { renderHelp } from './help.ts';
import { C } from '../terminal/colors.ts';

export interface TerminalSize {
  rows: number;
  cols: number;
}

export function render(app: TuiApp, size: TerminalSize): string {
  const out: string[] = [];

  // Clear screen + home
  out.push('\x1b[2J\x1b[H');

  if (size.cols < 20 || size.rows < 6) {
    out.push(`${C.gray}Terminal too small${C.reset}`);
    return out.join('');
  }

  // Header (row 1)
  out.push(renderHeader(app, size.cols));
  out.push('\n');

  const contentRows = size.rows - 3; // header + blank + footer

  if (app.mode === TuiMode.HELP) {
    const helpLines = renderHelp(size.cols, contentRows);
    for (const line of helpLines) {
      out.push(line + '\n');
    }
  } else {
    out.push('\n');
    const sessionLines = renderSessionList(app, 2, contentRows, size.cols);
    for (const line of sessionLines) {
      out.push(line + '\n');
    }
  }

  // Footer (last row)
  out.push(`\x1b[${size.rows};1H`);
  out.push(renderFooter(app, size.cols));

  return out.join('');
}
```

- [ ] **Step 4: Commit**

```bash
git add src/tui/dashboard.ts src/tui/render.ts src/tui/help.ts
git commit -m "feat: add TUI dashboard renderer with header, session list, help"
```

---

### Task 16: TUI — Preview Pane

**Files:**

- Create: `src/tui/preview.ts`

- [ ] **Step 1: Implement preview.ts**

```typescript
import { C } from '../terminal/colors.ts';
import { truncateAnsi, visibleLength } from '../terminal/ansi.ts';
import { STATUS_DISPLAY, type AgentState } from '../state/types.ts';
import { capturePane } from '../tmux/sessions.ts';

export function renderPreview(state: AgentState, width: number, height: number): string[] {
  const lines: string[] = [];
  const display = STATUS_DISPLAY[state.status];

  // Title line
  const title = `${display.icon} ${state.session} · ${state.status}`;
  const toolInfo = state.tool ? ` · ${state.tool}` : '';
  const portInfo = state.ports.length > 0 ? ` · ⌁${state.ports.join(',')}` : '';
  lines.push(truncateAnsi(`${C.bold}${title}${C.reset}${C.gray}${toolInfo}${portInfo}${C.reset}`, width));
  lines.push(`${C.gray}${'─'.repeat(width)}${C.reset}`);

  // Capture pane content
  const maxContentLines = height - 2;
  let paneLines: string[];
  try {
    paneLines = capturePane(state.paneId, maxContentLines);
  } catch {
    lines.push(`${C.gray}Preview unavailable${C.reset}`);
    return lines;
  }

  for (const line of paneLines) {
    lines.push(truncateAnsi(line, width));
  }

  // Pad to fill height
  while (lines.length < height) {
    lines.push('');
  }

  return lines.slice(0, height);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/preview.ts
git commit -m "feat: add TUI preview pane with live capture"
```

---

### Task 17: TUI — Send Mode

**Files:**

- Create: `src/tui/send.ts`

- [ ] **Step 1: Implement send.ts (TUI version)**

```typescript
import { C } from '../terminal/colors.ts';
import { AgentStatus, type AgentState } from '../state/types.ts';
import { truncateAnsi } from '../terminal/ansi.ts';

export function canSendTo(state: AgentState): { ok: boolean; reason: string } {
  switch (state.status) {
    case AgentStatus.IDLE:
    case AgentStatus.DONE:
      return { ok: true, reason: '' };
    case AgentStatus.BUSY:
      return { ok: false, reason: 'Agent is busy' };
    case AgentStatus.PERMIT:
      return { ok: false, reason: 'Agent has a permission prompt' };
    case AgentStatus.QUESTION:
      return { ok: false, reason: 'Agent is asking a question' };
    case AgentStatus.SHELL:
      return { ok: true, reason: '' };
    case AgentStatus.DOWN:
      return { ok: false, reason: 'No live process' };
  }
}

export function renderSendMode(state: AgentState, buffer: string, cols: number): string[] {
  const lines: string[] = [];
  const check = canSendTo(state);

  lines.push(`${C.bold}Send to ${state.session}${C.reset}`);
  lines.push('');

  if (!check.ok) {
    lines.push(`${C.red}Cannot send: ${check.reason}${C.reset}`);
    lines.push(`${C.gray}Press Esc to cancel${C.reset}`);
    return lines;
  }

  lines.push(`${C.gray}Type your prompt, Enter to send, Esc to cancel${C.reset}`);
  lines.push('');
  lines.push(truncateAnsi(`${C.cyan}> ${C.reset}${buffer}█`, cols));

  return lines;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/send.ts
git commit -m "feat: add TUI send mode with state gating"
```

---

### Task 18: Entry Point — CLI Dispatch + TUI Launch

**Files:**

- Create: `index.ts`

- [ ] **Step 1: Implement index.ts**

```typescript
import packageJson from './package.json' with { type: 'json' };
import { TuiApp, TuiMode } from './src/tui/app.ts';
import { render, type TerminalSize } from './src/tui/render.ts';
import { parseKeyEvent } from './src/terminal/input.ts';
import { isMouseSequence } from './src/terminal/mouse.ts';
import {
  enterAlternateScreen,
  hideCursor,
  enterRawMode,
  enableMouse,
  restore,
  getTerminalSize,
} from './src/terminal/terminal.ts';
import { StateEngine } from './src/state/engine.ts';
import { AgentRegistry } from './src/agents/registry.ts';
import { runStatus } from './src/cli/status.ts';
import { runNext } from './src/cli/next.ts';
import { runSend } from './src/cli/send.ts';
import { runInstall, runUninstall } from './src/cli/install.ts';
import { runDoctor } from './src/cli/doctor.ts';
import { runReconcile } from './src/cli/reconcile.ts';
import { switchClient } from './src/tmux/sessions.ts';
import { sendKeys } from './src/tmux/send.ts';
import { canSendTo } from './src/tui/send.ts';

const VERSION: string = packageJson.version;
const REFRESH_INTERVAL_MS = 500;

function printVersion(): number {
  process.stdout.write(`fleet ${VERSION}\n`);
  return 0;
}

function printHelp(): number {
  process.stdout.write(
    [
      'fleet — agent dashboard TUI',
      '',
      'Usage:',
      '  fleet                          Launch TUI dashboard',
      '  fleet status [--tmux] <session> Query agent state',
      '  fleet next                     Jump to next waiting agent',
      '  fleet send <session> <prompt>  Send prompt to session',
      '  fleet install                  Register as Claude Code plugin',
      '  fleet uninstall                Remove plugin registration',
      '  fleet doctor                   Health check',
      '  fleet reconcile [--dry-run]    Sweep orphan status files',
      '  fleet --version, -v            Print version',
      '  fleet --help, -h               Show this help',
      '',
    ].join('\n'),
  );
  return 0;
}

function handleCli(args: string[]): number | null {
  if (args.includes('--version') || args.includes('-v')) return printVersion();
  if (args.includes('--help') || args.includes('-h')) return printHelp();

  const command = args[0];
  if (!command) return null; // Launch TUI

  const registry = new AgentRegistry();
  const engine = new StateEngine(registry.statusDirs());

  switch (command) {
    case 'status': {
      const states = engine.refresh();
      const output = runStatus(args.slice(1), states);
      if (output.length > 0) process.stdout.write(output + '\n');
      return 0;
    }
    case 'next': {
      const states = engine.refresh();
      return runNext(states);
    }
    case 'send': {
      const session = args[1];
      const prompt = args.slice(2).join(' ');
      if (!session || !prompt) {
        process.stderr.write('Usage: fleet send <session> <prompt>\n');
        return 1;
      }
      const states = engine.refresh();
      const force = args.includes('--force');
      return runSend(session, prompt, states, force);
    }
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'doctor':
      return runDoctor();
    case 'reconcile': {
      const dryRun = args.includes('--dry-run');
      const verbose = args.includes('--verbose') || args.includes('-v');
      return runReconcile(dryRun, verbose);
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      return 1;
  }
}

async function launchTui(): Promise<number> {
  const registry = new AgentRegistry();
  const engine = new StateEngine(registry.statusDirs());
  const app = new TuiApp();

  enterAlternateScreen();
  hideCursor();
  enterRawMode();
  enableMouse();

  let needsRender = true;

  const draw = () => {
    const size = getTerminalSize();
    process.stdout.write(render(app, size));
  };

  const refreshState = () => {
    const states = engine.refresh();
    app.updateStates(states);
    needsRender = true;
  };

  refreshState();

  engine.startWatching(() => {
    refreshState();
    if (needsRender) draw();
  });

  return await new Promise<number>((resolve) => {
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (code: number) => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      engine.stop();
      process.stdin.removeAllListeners('data');
      restore();
      resolve(code);
    };

    const tick = () => {
      if (needsRender) {
        draw();
        needsRender = false;
      }
      if (app.shouldQuit) finish(0);
    };

    const handleInput = (buf: Buffer) => {
      if (isMouseSequence(buf)) return;

      const key = parseKeyEvent(buf);

      // Global: Ctrl-C quits
      if (key.type === 'ctrl' && key.char === 'c') {
        app.shouldQuit = true;
        return;
      }

      // Mode-specific handling
      if (app.mode === TuiMode.HELP) {
        app.mode = TuiMode.DASHBOARD;
        needsRender = true;
        return;
      }

      if (app.mode === TuiMode.SEND) {
        handleSendInput(app, key);
        needsRender = true;
        return;
      }

      // Filter mode (typing after /)
      if (app.getFilter().length > 0 || (key.type === 'char' && key.char === '/')) {
        if (key.type === 'char' && key.char === '/' && app.getFilter().length === 0) {
          app.setFilter('');
          needsRender = true;
          return;
        }
        handleFilterInput(app, key);
        needsRender = true;
        return;
      }

      // Dashboard mode
      switch (key.type) {
        case 'escape':
          if (app.getFilter().length > 0) {
            app.clearFilter();
          } else {
            app.shouldQuit = true;
          }
          break;
        case 'char':
          switch (key.char) {
            case 'q':
              app.shouldQuit = true;
              break;
            case 'j':
              app.moveDown();
              break;
            case 'k':
              app.moveUp();
              break;
            case 'p':
              app.mode = app.mode === TuiMode.PREVIEW ? TuiMode.DASHBOARD : TuiMode.PREVIEW;
              break;
            case 's': {
              const selected = app.selectedState();
              if (selected) {
                app.mode = TuiMode.SEND;
                app.sendBuffer = '';
              }
              break;
            }
            case 'n': {
              const states = engine.refresh();
              runNext(states);
              finish(0);
              return;
            }
            case '?':
              app.mode = TuiMode.HELP;
              break;
            case '/':
              app.setFilter('');
              break;
          }
          break;
        case 'enter': {
          const selected = app.selectedState();
          if (selected) {
            try {
              finish(0);
              switchClient(selected.paneId);
            } catch {
              // Stay in TUI on failure
            }
            return;
          }
          break;
        }
        case 'arrow':
          if (key.direction === 'up') app.moveUp();
          if (key.direction === 'down') app.moveDown();
          break;
      }
      needsRender = true;
    };

    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      handleInput(buf);
      tick();
    });

    process.stdout.on('resize', () => {
      needsRender = true;
      tick();
    });

    process.on('SIGWINCH', () => {
      needsRender = true;
      tick();
    });

    refreshTimer = setInterval(() => {
      refreshState();
      tick();
    }, REFRESH_INTERVAL_MS);

    tick();
  });
}

function handleFilterInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>): void {
  switch (key.type) {
    case 'escape':
      app.clearFilter();
      break;
    case 'backspace': {
      const f = app.getFilter();
      app.setFilter(f.slice(0, -1));
      break;
    }
    case 'char':
      app.setFilter(app.getFilter() + key.char);
      break;
    case 'arrow':
      if (key.direction === 'up') app.moveUp();
      if (key.direction === 'down') app.moveDown();
      break;
    case 'enter': {
      const selected = app.selectedState();
      if (selected) {
        restore();
        switchClient(selected.paneId);
        app.shouldQuit = true;
      }
      break;
    }
  }
}

function handleSendInput(app: TuiApp, key: ReturnType<typeof parseKeyEvent>): void {
  switch (key.type) {
    case 'escape':
      app.mode = TuiMode.DASHBOARD;
      app.sendBuffer = '';
      break;
    case 'backspace':
      app.sendBuffer = app.sendBuffer.slice(0, -1);
      break;
    case 'char':
      app.sendBuffer += key.char;
      break;
    case 'enter': {
      const selected = app.selectedState();
      if (selected && app.sendBuffer.length > 0) {
        const check = canSendTo(selected);
        if (check.ok) {
          try {
            sendKeys(selected.paneId, app.sendBuffer);
          } catch {
            // Silently fail — TUI will show updated state
          }
        }
      }
      app.mode = TuiMode.DASHBOARD;
      app.sendBuffer = '';
      break;
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cliResult = handleCli(args);
  if (cliResult !== null) return cliResult;
  return launchTui();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    restore();
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Verify it compiles**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Test CLI flags**

```bash
bun run dev -- --version
bun run dev -- --help
```

Expected: Prints version and help text.

- [ ] **Step 4: Build the binary**

```bash
bun run build
./dist/fleet --version
```

Expected: Prints `fleet 0.1.0`

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: add entry point with CLI dispatch and TUI launch"
```

---

### Task 19: CI/CD Workflows

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/lint-pr-title.yml`
- Create: `Formula/fleet.rb`

- [ ] **Step 1: Create ci.yml**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  BUN_VERSION: '1.3.13'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run lint

  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run format:check

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run typecheck

  compile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ env.BUN_VERSION }}
      - run: bun install --frozen-lockfile
      - run: bun run build
```

- [ ] **Step 2: Create release.yml**

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.rp.outputs.release_created }}
      tag_name: ${{ steps.rp.outputs.tag_name }}
    steps:
      - id: rp
        uses: googleapis/release-please-action@v4
        with:
          config-file: .release-please-config.json
          manifest-file: .release-please-manifest.json
          token: ${{ secrets.GITHUB_TOKEN }}

  build:
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created }}
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: bun-darwin-arm64
            artifact: fleet-darwin-arm64
          - os: macos-latest
            target: bun-darwin-x64
            artifact: fleet-darwin-x86_64
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: fleet-linux-x86_64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Compile binary
        run: bun build --compile --minify --target=${{ matrix.target }} index.ts --outfile fleet
      - name: Package tarball
        run: tar czf ${{ matrix.artifact }}.tar.gz fleet
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}.tar.gz

  attach-binaries:
    needs: [release-please, build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          merge-multiple: true
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.release-please.outputs.tag_name }}
          files: '*.tar.gz'

  update-formula:
    needs: [release-please, build]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout tap repo
        uses: actions/checkout@v4
        with:
          repository: nicknisi/homebrew-formulae
          token: ${{ secrets.HOMEBREW_TAP_TOKEN }}
          path: tap
      - uses: actions/download-artifact@v4
        with:
          merge-multiple: true
      - name: Update formula
        env:
          VERSION: ${{ needs.release-please.outputs.tag_name }}
        run: |
          VER="${VERSION#v}"
          SHA_ARM64=$(shasum -a 256 fleet-darwin-arm64.tar.gz | cut -d' ' -f1)
          SHA_X86_64=$(shasum -a 256 fleet-darwin-x86_64.tar.gz | cut -d' ' -f1)
          SHA_LINUX=$(shasum -a 256 fleet-linux-x86_64.tar.gz | cut -d' ' -f1)
          cd tap
          sed -i "s/version \".*\"/version \"${VER}\"/" Formula/fleet.rb
          python3 -c "
          import re
          f = 'Formula/fleet.rb'
          txt = open(f).read()
          shas = {'arm64': '${SHA_ARM64}', 'x86_64': '${SHA_X86_64}', 'linux': '${SHA_LINUX}'}
          for arch, sha in shas.items():
              txt = re.sub(r'(fleet-.*' + arch + r'.*\n\s*sha256 \")([a-fA-F0-9]+|PLACEHOLDER_\w+)(\")', lambda m: m.group(1) + sha + m.group(3), txt)
          open(f, 'w').write(txt)
          "
      - name: Commit formula
        env:
          TAG_NAME: ${{ needs.release-please.outputs.tag_name }}
        run: |
          cd tap
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add Formula/fleet.rb
          git diff --cached --quiet || git commit -m "fleet: update to ${TAG_NAME}"
          git push
```

- [ ] **Step 3: Create lint-pr-title.yml**

```yaml
name: Lint PR Title

on:
  pull_request:
    types: [opened, edited, synchronize]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Create Formula/fleet.rb**

```ruby
class Fleet < Formula
  desc "Agent dashboard TUI for managing AI sessions in tmux"
  homepage "https://github.com/nicknisi/fleet"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/nicknisi/fleet/releases/download/v#{version}/fleet-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_ARM64"
    else
      url "https://github.com/nicknisi/fleet/releases/download/v#{version}/fleet-darwin-x86_64.tar.gz"
      sha256 "PLACEHOLDER_X86_64"
    end
  end

  on_linux do
    url "https://github.com/nicknisi/fleet/releases/download/v#{version}/fleet-linux-x86_64.tar.gz"
    sha256 "PLACEHOLDER_LINUX"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/fleet --version 2>&1", 1)
  end
end
```

- [ ] **Step 5: Commit**

```bash
mkdir -p .github/workflows Formula
git add .github/ Formula/
git commit -m "chore: add CI/CD workflows and Homebrew formula"
```

---

### Task 20: Integration — Full Build + Smoke Test

- [ ] **Step 1: Install dependencies**

```bash
bun install
```

- [ ] **Step 2: Run all checks in parallel**

```bash
bun run lint
bun run format:check
bun run typecheck
bun test
```

Expected: All pass.

- [ ] **Step 3: Build the binary**

```bash
bun run build
```

Expected: `dist/fleet` is created.

- [ ] **Step 4: Smoke test CLI**

```bash
./dist/fleet --version
./dist/fleet --help
./dist/fleet doctor
./dist/fleet reconcile --dry-run --verbose
```

Expected: All produce reasonable output.

- [ ] **Step 5: Test TUI launch**

```bash
bun run dev
```

Expected: TUI launches in alt screen, shows agent state dashboard. Press `q` to quit.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: fleet v0.1.0 — agent dashboard TUI"
```

---

## Spec Coverage Self-Review

| Spec Section                      | Task(s)                        |
| --------------------------------- | ------------------------------ |
| Architecture (hybrid hooks + TUI) | Tasks 10 + 18                  |
| State Engine (3 layers)           | Tasks 6, 7, 8, 9               |
| State Model (7 states)            | Task 2                         |
| Freshness Invariant               | Task 9 (engine.ts fuseState)   |
| TUI Dashboard                     | Tasks 14, 15                   |
| Preview Pane                      | Task 16                        |
| Send Mode                         | Task 17                        |
| Keybindings                       | Task 18 (index.ts handleInput) |
| Rendering (raw ANSI)              | Tasks 3, 15                    |
| CLI commands                      | Tasks 12, 13                   |
| Plugin structure                  | Tasks 10, 11                   |
| Hook scripts                      | Task 10                        |
| Agent Registry                    | Task 5                         |
| Backward compat (agents.conf)     | Task 5 (config.ts)             |
| Toolchain (mirrors tm)            | Task 1                         |
| CI/CD                             | Task 19                        |
| Distribution (Homebrew)           | Task 19                        |
| Notification splitting            | Task 10 (notification.sh)      |
| Grace period                      | Task 10 (stop.sh)              |
| Background task guard             | Task 10 (stop.sh)              |
| JSONL event append                | Task 10 (lib.sh)               |
| Status bar integration            | Task 12                        |
