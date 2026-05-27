# fleet

A terminal dashboard for managing multiple AI agent sessions in tmux.

Fleet watches your Claude Code sessions, shows which agents need attention, and lets you send prompts — all from a single pane. It replaces a sprawl of bash scripts with a compiled Bun binary and a Claude Code plugin that hooks into the event system automatically.

## Install

### Homebrew

```bash
brew install nicknisi/formulae/fleet
```

### From source

```bash
git clone https://github.com/nicknisi/fleet.git
cd fleet
bun install
bun run build
# Binary is at dist/fleet — add to your PATH
```

### Claude Code plugin

Fleet hooks into Claude Code's event system to track agent state in real time. Install the plugin after building:

```bash
fleet install
```

This registers Fleet as a local marketplace and installs the plugin. The hooks start firing immediately in all new Claude Code sessions — no `settings.json` editing required.

To remove:

```bash
fleet uninstall
```

## Usage

### TUI Dashboard

```bash
fleet                   # Launch dashboard (preview auto-opens on wide terminals)
fleet --preview         # Force preview pane on
fleet --no-preview      # Force preview pane off
```

The dashboard shows every Claude Code pane grouped by urgency. Agents that need you sort to the top. Plain shell panes are hidden — you're here for the agents.

### Keybindings

| Key | Action |
|-----|--------|
| `j` / `k` or `Up` / `Down` | Navigate sessions |
| `Enter` | Switch to selected session |
| `n` | Jump to next waiting agent (cycles) |
| `p` | Toggle preview pane |
| `s` | Send prompt to selected session |
| `/` | Filter sessions by name or project |
| `?` | Help overlay |
| `q` or `Esc` | Quit (or clear filter) |

### Agent States

Fleet tracks seven states, sorted by urgency. The icon and color tell you what's happening at a glance:

| Icon | State | Meaning |
|------|-------|---------|
| `⚠` | **waiting** | Tool approval needed (`[y/n]` prompt) |
| `?` | **asking** | Agent asked you a question |
| `✓` | **done** | Task finished, needs your next prompt |
| `◉` | **working** | Thinking or running tools |
| `●` | **idle** | Up but no recent activity |
| `■` | **shell** | No agent running (hidden by default) |
| `○` | **down** | No live process (hidden by default) |

### Send Mode

Press `s` to send a prompt to the selected agent. Fleet auto-selects the first sendable session if the current one is busy or waiting for approval.

**State gating:** Fleet refuses to send to sessions with permission prompts (won't accidentally approve), sessions asking questions (won't answer for you), or dead sessions. Use `--force` in the CLI to override the busy check.

### Preview Pane

Press `p` to toggle a live `tmux capture-pane` view of the selected session. Shows actual terminal output so you can verify state visually. Opens automatically on terminals wider than 120 columns.

The preview shows:
- Live pane content (ANSI color preserved)
- State badge and current tool
- Listening ports (e.g., `⌁3000`)

## CLI Commands

Fleet also works as a non-interactive CLI for scripting and tmux integration.

| Command | Description |
|---------|-------------|
| `fleet status [--tmux] <session>` | Query agent state. `--tmux` outputs a tmux format string for status bars. |
| `fleet next` | Switch to the next waiting agent pane (cycles through PERMIT > QUESTION > DONE). |
| `fleet send <session> <prompt>` | Send a prompt to a session. Refuses unsafe states unless `--force`. |
| `fleet doctor` | Check tmux version, plugin installation, status directories, hook health. |
| `fleet reconcile [--dry-run] [--verbose]` | Remove orphan status files for dead panes, fix stale working states. |
| `fleet install` | Register Fleet as a Claude Code plugin. |
| `fleet uninstall` | Remove the plugin registration. |

### Tmux Status Bar Integration

Add to your tmux config to show agent status in the status bar:

```
set -g status-right '#(fleet status --tmux #{session_name})'
```

Shows a colored icon when agents in the current session need attention. Empty otherwise.

### Tmux Keybindings

```
bind-key y display-popup -E -w 90% -h 50% "fleet"
bind-key n run-shell "fleet next"
```

## Architecture

Fleet has two halves that talk through the filesystem:

```
Hooks (bash, fast)              TUI (Bun, interactive)
──────────────────              ──────────────────────
Claude Code fires events   ──>  Reads status files
  Notification                   Reads JSONL event logs
  PreToolUse                     Scrapes pane content
  Stop / SubagentStop            Fuses into 7-state model
  SessionEnd                     Renders dashboard
       │                                │
       ▼                                ▼
  ~/.cache/claude-status/       Single-string ANSI frames
    {pane_num}.status            (no flicker, no framework)
    {pane_num}.events.jsonl
```

### Three-Layer State Engine

Fleet doesn't trust any single signal. It fuses three layers for high-confidence state:

1. **Hook signals** (Layer 1, ~0ms) — Claude Code hooks write JSON status files on every event. Fast but can disagree with reality.

2. **JSONL event stream** (Layer 2) — Each hook appends to a per-pane event log. The TUI reads only the last event. Key insight: a `stop_reason` of `tool_use` means the agent is about to run another tool (BUSY), while `end_turn` means actually done.

3. **Pane scraping** (Layer 3, ~50ms) — `tmux capture-pane` as the visual arbiter. Detects `[y/n]` permission prompts visually. Used as a tiebreaker when layers 1+2 disagree.

**Freshness invariant:** A state transition is only accepted if its timestamp is newer than the current state's timestamp. Prevents out-of-order hook deliveries from causing flicker.

**Decay:** `done` decays to `idle` after 60 seconds. `working` times out to `idle` after 3 minutes.

### Hook Details

The Claude Code plugin (`hooks/`) fires on five events:

- **Notification** — Splits into three sub-types: `permission_prompt` (waiting), `elicitation_dialog` (asking), `idle_prompt` (done)
- **PreToolUse** — Agent is running a tool (working)
- **Stop** — Agent stopped. `tool_use` stop reason = still working. `end_turn` = actually done. Background tasks suppress completion. 3-second grace period before marking done.
- **SubagentStop** — Subagent finished; parent keeps working
- **SessionEnd** — Cleanup status and event files

Each hook script sources `hooks/lib.sh` which handles status file writes, JSONL event appends, and tmux notifications (with self-notification suppression).

### Performance

The TUI separates cheap and expensive operations:

- **Every 500ms:** Re-read `.status` files + one `tmux list-panes` call. No subprocesses beyond that.
- **Every 5s:** Refresh git branches (`git rev-parse` per unique path) and port detection (`lsof`).
- **On keypress:** Zero subprocess calls. Just redraws from cached state.
- **During send/filter:** All refresh timers pause. The event loop is yours.
- **JSONL reads:** Only the last line is parsed (not the entire file).

## Agent Configuration

Fleet reads agent directories from (in priority order):

1. `~/.config/fleet/agents.json` (new format)
2. `~/.config/agent-status/agents.conf` (legacy format)
3. Hardcoded fallback: `~/.cache/claude-status` + `~/.cache/pi-status`

### New format (`agents.json`)

```json
{
  "agents": [
    { "name": "claude", "statusDir": "~/.cache/fleet/claude" },
    { "name": "codex", "statusDir": "~/.cache/fleet/codex" }
  ]
}
```

### Legacy format (`agents.conf`)

```ini
# name=directory
claude=$HOME/.cache/claude-status
pi=$HOME/.cache/pi-status
```

## Development

Fleet is a zero-dependency Bun project.

```bash
bun install              # Install dev dependencies
bun run dev              # Run without compiling
bun run build            # Compile to standalone binary (dist/fleet)
bun test                 # Run tests (74 tests, ~30ms)
bun run typecheck        # tsc --noEmit
bun run lint             # oxlint
bun run format           # oxfmt
bun run format:check     # oxfmt --check
```

### Project Structure

```
fleet/
├── index.ts                  # Entry: CLI dispatch + TUI event loop
├── src/
│   ├── state/                # Three-layer state engine
│   │   ├── types.ts          # AgentStatus enum, AgentState, priority
│   │   ├── hooks.ts          # Layer 1: status file reader + fs.watch
│   │   ├── events.ts         # Layer 2: JSONL parser (last-line optimized)
│   │   ├── scraper.ts        # Layer 3: pane content pattern matching
│   │   └── engine.ts         # Fuser: fuseState() with freshness invariant
│   ├── tui/                  # Terminal UI
│   │   ├── app.ts            # App state model (sort, filter, modes)
│   │   ├── dashboard.ts      # Header, session list, footer, legend
│   │   ├── preview.ts        # Live pane capture renderer
│   │   ├── send.ts           # Send mode with state gating
│   │   ├── help.ts           # Keybinding overlay
│   │   └── render.ts         # Frame compositor (no-flicker rendering)
│   ├── terminal/             # Terminal primitives (ported from tm)
│   │   ├── ansi.ts           # Strip, width calc, CJK/emoji truncation
│   │   ├── colors.ts         # Catppuccin Mocha palette + NO_COLOR
│   │   ├── input.ts          # Key event parsing
│   │   ├── mouse.ts          # SGR mouse protocol
│   │   └── terminal.ts       # Raw mode, alt screen, cleanup
│   ├── tmux/                 # Tmux IPC
│   │   ├── ipc.ts            # Bun.spawnSync wrappers
│   │   ├── sessions.ts       # Pane listing, capture, switch, git
│   │   ├── send.ts           # Multi-line send-keys
│   │   └── ports.ts          # Listening port detection via lsof
│   ├── agents/               # Agent configuration
│   │   ├── config.ts         # Config loader (new + legacy + fallback)
│   │   └── registry.ts       # Agent type → status dir mapping
│   └── cli/                  # Non-interactive commands
│       ├── status.ts         # fleet status [--tmux]
│       ├── next.ts           # fleet next
│       ├── send.ts           # fleet send
│       ├── install.ts        # fleet install / uninstall
│       ├── doctor.ts         # fleet doctor
│       └── reconcile.ts      # fleet reconcile
├── hooks/                    # Claude Code plugin hooks (bash)
│   ├── hooks.json            # Event declarations
│   ├── lib.sh               # Shared: status write, JSONL append, notify
│   ├── notification.sh       # PERMIT / QUESTION / DONE splitting
│   ├── pre-tool-use.sh       # → BUSY
│   ├── stop.sh              # → DONE (grace period + bg task guard)
│   ├── subagent-stop.sh     # Subagent done, parent continues
│   └── session-end.sh       # Cleanup
├── .claude-plugin/
│   └── plugin.json           # Claude Code plugin manifest
├── .github/workflows/        # CI (lint/format/typecheck/compile)
│   ├── ci.yml                # + release-please + cross-compile
│   ├── release.yml
│   └── lint-pr-title.yml
└── Formula/
    └── fleet.rb              # Homebrew formula
```

### Rendering

Fleet uses the same approach as [tm](https://github.com/nicknisi/tm): raw ANSI escape sequences, no TUI framework. Each frame is built as a single string and written to stdout in one `process.stdout.write()` call. The cursor homes to `\x1b[H` and each line clears to end with `\x1b[K` — no full screen clear, no flicker.

Colors use the Catppuccin Mocha palette via 24-bit RGB escape sequences, with `NO_COLOR` and non-TTY detection.

### Testing

Tests are collocated (`*.test.ts` next to source). The state engine, ANSI utilities, and TUI model are unit-tested. Tmux-dependent code has integration-style tests that gracefully degrade outside tmux.

```bash
bun test                 # 74 tests, ~30ms
bun test src/state/      # State engine only
bun test src/terminal/   # Terminal primitives only
bun test src/tui/        # TUI model only
```

## License

MIT
