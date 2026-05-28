# fleet

A terminal dashboard for managing multiple AI agent sessions in tmux.

Fleet watches your Claude Code sessions, shows which agents need attention, and lets you send prompts — all from a single pane. It replaces a sprawl of bash scripts with a compiled Bun binary and a Claude Code plugin that hooks into the event system automatically.

<img width="3744" height="2402" alt="capture_20260527_180922" src="https://github.com/user-attachments/assets/0ad4ea10-948f-4e64-a509-9ad7ca2a2db4" />

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

This does three things:

1. Registers Fleet as a Claude Code plugin (hooks fire automatically in all new sessions)
2. Adds a second tmux status row showing all active agents
3. Adds a `run-shell` line to your tmux.conf (marked `# fleet-managed`)

No `settings.json` editing required.

To remove everything cleanly:

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

Each row leads with the tmux session name. When Claude Code has auto-named a session (the descriptive title it generates per task), Fleet shows that name in the detail column so you can tell sessions apart at a glance. Filtering with `/` matches on session name, Claude name, and project path.

### Keybindings

| Key                        | Action                              |
| -------------------------- | ----------------------------------- |
| `j` / `k` or `Up` / `Down` | Navigate sessions                   |
| `Enter`                    | Switch to selected session          |
| `n`                        | Jump to next waiting agent (cycles) |
| `p`                        | Toggle preview pane                 |
| `s`                        | Send prompt to selected session     |
| `i`                        | Enter passthrough (preview mode)    |
| `y`                        | Approve permission prompt (preview) |
| `/`                        | Filter sessions by name or project  |
| `x`                        | Kill selected session (confirms first) |
| `?`                        | Help overlay                        |
| `q` or `Esc`               | Quit (or clear filter)              |

### Agent States

Fleet tracks seven states, sorted by urgency. The icon and color tell you what's happening at a glance:

| Icon | State       | Meaning                                            |
| ---- | ----------- | -------------------------------------------------- |
| `⚠`  | **waiting** | Tool approval needed (`[y/n]` prompt)              |
| `?`  | **asking**  | Agent asked you a question (`AskUserQuestion`)     |
| `▸`  | **ready**   | Turn ended — your move (finished, or asked in prose) |
| `◉`  | **working** | Thinking or running tools                          |
| `●`  | **idle**    | Up but no recent activity                          |
| `■`  | **shell**   | No agent running (hidden by default)               |
| `○`  | **down**    | No live process (hidden by default)                |

**asking vs. ready:** A turn that ends — whether the agent finished the task or asked you something in prose — looks identical at the hook layer (both are a plain `Stop`). Fleet can't tell them apart, so both land in **ready** ("your move"). The dedicated **asking** state is only reachable through structured signals the agent emits: the `AskUserQuestion` tool and MCP elicitation dialogs. Either way both sort into the attention tier, so nothing that needs you gets buried.

### Send Mode

Press `s` to send a prompt to the selected agent. Fleet auto-selects the first sendable session if the current one is busy or waiting for approval.

**State gating:** Fleet refuses to send to sessions with permission prompts (won't accidentally approve), sessions asking questions (won't answer for you), or dead sessions. Use `--force` in the CLI to override the busy check.

### Kill Session

Press `x` to kill the selected session's pane. Fleet asks you to confirm (`y`) before closing it — any other key cancels.

**State gating:** Same philosophy as send. Fleet only reaps sessions that are finished, idle, or already dead. It refuses to kill a working agent, one waiting on a permission prompt, or one asking a question — so you don't discard work or a pending decision by reflex.

### Preview Pane

Press `p` to toggle a live `tmux capture-pane` view of the selected session. Shows actual terminal output so you can verify state visually. Opens automatically on terminals wider than 120 columns.

The preview shows:

- Live pane content (ANSI color preserved)
- State badge and current tool
- Listening ports (e.g., `⌁3000`)
- Context-aware quick actions based on agent state

**Resize the split:** Drag the divider between the session list and the preview with the mouse, just like dragging a tmux pane border. The divider highlights while you drag and the split clamps between 20% and 80%.

### Quick Actions

When the preview pane is open, Fleet shows context-aware actions at the bottom of the preview based on the agent's current state:

- **waiting** — `y` to approve, `n` to deny the permission prompt
- **asking** — `i` to answer inline via passthrough, `s` to send a prompt
- **ready/idle** — `i` for passthrough, `s` to send the next prompt
- **working** — `i` for passthrough (watch and interact)

### Passthrough Mode

Press `i` from the preview to enter passthrough mode. Every keystroke is forwarded directly to the agent's tmux pane — the preview updates live so you can see the result without leaving Fleet. Press `Esc` to exit back to the dashboard.

This is the power feature: approve prompts, answer questions, type commands, and watch the output — all without switching panes. The footer shows `● LIVE` when passthrough is active.

## CLI Commands

Fleet also works as a non-interactive CLI for scripting and tmux integration.

| Command                                   | Description                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `fleet status [--tmux] <session>`         | Query agent state. `--tmux` outputs a tmux format string for status bars.        |
| `fleet status --statusline`               | Render a full multi-agent status line for tmux's second row.                     |
| `fleet next`                              | Switch to the next waiting agent pane (cycles through PERMIT > QUESTION > DONE). |
| `fleet send <session> <prompt>`           | Send a prompt to a session. Refuses unsafe states unless `--force`.              |
| `fleet doctor`                            | Check tmux version, plugin installation, status directories, hook health.        |
| `fleet reconcile [--dry-run] [--verbose]` | Remove orphan status files for dead panes, fix stale working states.             |
| `fleet install`                           | Register Fleet as a Claude Code plugin + add second tmux status row.             |
| `fleet uninstall`                         | Remove plugin registration + tmux status row.                                    |
| `fleet statusline --inject`               | Manually add the second tmux status row.                                         |
| `fleet statusline --remove`               | Manually remove the second tmux status row.                                      |

### Tmux Status Bar Integration

Fleet supports two levels of tmux integration:

**Second status row (recommended):** A dedicated row showing all agents that need attention, with clickable entries. Set up automatically by `fleet install`, or manually:

```bash
fleet statusline --inject
```

Each entry is clickable (tmux 3.2+) — click an agent name to switch to that session. Only agents that are actively blocked on you appear: PERMIT (tool approval) and QUESTION (a question to answer). Working, done, idle, and shell sessions stay out of the bar — they don't need you to act, so they'd just be noise. Watch those in the dashboard instead.

**Status-right icon (lightweight):** A single icon in your existing status bar:

```
set -g status-right '#(fleet status --tmux #{session_name})'
```

Shows a colored icon when agents in the current session need attention. Empty otherwise.

### Tmux Keybindings

```
bind-key y display-popup -E -w 90% -h 70% "fleet"
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

3. **Pane scraping** (Layer 3, ~50ms) — `tmux capture-pane` as the visual arbiter. Detects permission prompts (`[y/n]`), question dialogs (`Enter to select`), the working token counter (`(1m 11s · ↓ 3.4k tokens)`), and idle prompts. The scraper is authoritative only for what it can read unambiguously off the screen — `PERMIT` and `QUESTION` always win. For working-vs-idle it defers to the hooks: a scraper miss (Claude's spinner animates between capture frames) can't downgrade a fresh `working` hook to idle, but a scraped idle prompt does clear a stale permission.

**Freshness invariant:** A state transition is only accepted if its timestamp is newer than the current state's timestamp. Prevents out-of-order hook deliveries from causing flicker.

**Verify on switch:** When you navigate to a pane (Enter or click), Fleet scrapes it immediately and updates the status file. Stale states get corrected the moment you look at them.

**Decay:** `ready` never auto-decays — a finished turn is waiting on you and stays until you act on it (switch to it, send a prompt, or it starts working again). Only `working` times out to `idle`, after 3 minutes, so a crashed turn doesn't spin forever.

### Hook Details

The Claude Code plugin (`hooks/`) fires on five events:

- **Notification** — Splits into three sub-types: `permission_prompt` → permit, `elicitation_dialog` → question, `idle_prompt` → ready
- **PreToolUse** — Agent is running a tool (working). The `AskUserQuestion` tool is the exception — it means the agent is asking _you_, so it maps to **asking**, not working.
- **Stop** — Agent stopped. `tool_use` stop reason = still working. `end_turn` = turn over (ready). Background tasks suppress completion. 3-second grace period.
- **SubagentStop** — Subagent finished; parent keeps working
- **SessionEnd** — Cleanup status and event files

Each hook script sources `hooks/lib.sh` which handles status file writes, JSONL event appends, and tmux notifications (with self-notification suppression).

### Performance

The TUI separates cheap and expensive operations:

- **Every 500ms:** Re-read `.status` files + one `tmux list-panes` call + JSONL last-line read. No subprocesses beyond that.
- **Every 5s:** Refresh git branches (`git rev-parse` per unique path), port detection (`lsof`), and pane scraping (`tmux capture-pane` per pane, ~50ms each).
- **On keypress:** Zero subprocess calls. Just redraws from cached state.
- **On switch:** Scrapes the target pane and corrects the status file before switching. Stale states are fixed the moment you navigate to them.
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
bun test                 # Run tests (147 tests, ~50ms)
bun run typecheck        # tsc --noEmit
bun run lint             # oxlint
bun run format           # oxfmt
bun run format:check     # oxfmt --check
```

### Testing

Tests are collocated (`*.test.ts` next to source). The state engine, ANSI utilities, TUI model, and CLI commands are unit-tested. Tmux-dependent code has integration-style tests that gracefully degrade outside tmux.

```bash
bun test                 # 147 tests, ~50ms
bun test src/state/      # State engine only
bun test src/terminal/   # Terminal primitives only
bun test src/tui/        # TUI model only
bun test src/cli/        # CLI commands
```

## Demo video

https://github.com/user-attachments/assets/2a9ce8db-767e-4260-a0e4-0a61562acef7

## License

MIT
