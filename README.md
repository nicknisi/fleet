# fleet

A terminal dashboard for managing multiple AI agent sessions in tmux.

Fleet watches your Claude Code sessions, shows which agents need attention, and lets you send prompts — all from a single pane. It replaces a sprawl of bash scripts with a compiled Bun binary and a Claude Code plugin that hooks into the event system automatically. Beyond hooked agents (Claude Code, Codex, pi), it also surfaces ones it has no integration for — aider, opencode, and the like — by spotting them in the process table.

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

No `settings.json` editing required. Install also offers two optional tmux keybindings — a sidebar split and a popup (see [Sidebar & popup](#sidebar--popup)).

To remove everything cleanly:

```bash
fleet uninstall
```

### Codex

Fleet also tracks [Codex](https://github.com/openai/codex) sessions. Codex has no plugin marketplace, so `fleet install codex` wires fleet into Codex's own config instead:

```bash
fleet install codex
```

This:

1. Creates the Codex status dir (`~/.cache/codex-status`)
2. Adds fleet `PreToolUse` + `Stop` hooks to `~/.codex/hooks.json` (your own Codex hooks are preserved)
3. Ensures `[features] hooks = true` in `~/.codex/config.toml`
4. Registers `codex` in `~/.config/fleet/agents.json`

Re-run it after a `brew upgrade` to re-point fleet's hook path. Codex panes then appear on the dashboard labeled `codex`, alongside `claude`. To reverse it (leaving your own Codex hooks intact):

```bash
fleet uninstall codex
```

### pi

Fleet also tracks [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) sessions. pi has no shell hooks, but it loads extensions from installed packages. `fleet install pi` registers fleet's `hooks/pi` directory as a local pi package:

```bash
fleet install pi
```

This:

1. Adds `hooks/pi` to `packages` in `~/.pi/agent/settings.json` (your own pi extensions and packages are untouched)
2. Creates the pi status dir (`~/.cache/pi-status`)
3. Registers `pi` in `~/.config/fleet/agents.json`

The extension publishes fleet status from pi's lifecycle events, so pi panes appear on the dashboard labeled `pi` (working / idle / done). pi auto-runs its tools, so there is no permission-prompt state to surface. Question tools do surface QUESTION while awaiting input: `@juicesharp/rpiv-ask-user-question` via its stable blocked event, and compatibility-shimmed `AskUserQuestion` tools via pi's `tool_call` lifecycle. Homebrew upgrades update the registered package in place; in an already-running pi session, `/reload` picks it up. To reverse it (leaving your own pi extensions and packages intact):

```bash
fleet uninstall pi
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

The header carries a live summary strip — `N need you · N working · N ready · N idle` — so you can read the fleet's overall state without scanning rows. When there's nothing to list, Fleet tells you _why_ with a distinct empty state: tmux isn't running, the hooks aren't installed yet, your filter matched nothing, or everything's genuinely quiet.

A few more cues while you work:

- **Hover** — the row under your mouse underlines, so you can see what a click will select.
- **Scroll indicators** — `↑ N more` / `↓ N more` appear when the list outruns the viewport.
- **Busy pulse** — a working agent's `◉` icon pulses on each tick, so active turns read as alive at a glance.

### Sidebar & popup

`fleet install` offers two optional tmux keybindings (each confirm-gated, marked `# fleet-managed` so `fleet uninstall` strips them again):

- **`prefix` + `f`** — open Fleet in a 34-column sidebar split on the left, alongside your work.
- **`prefix` + `F`** — open Fleet in a popup that floats over your current pane (`display-popup -E`).

Below 48 columns — like that narrow sidebar — Fleet automatically reflows the table into stacked cards with a compact footer. Same binary, no flag: wide panes get the table, narrow ones get cards.

### Keybindings

| Key                        | Action                                     |
| -------------------------- | ------------------------------------------ |
| `j` / `k` or `Up` / `Down` | Navigate sessions                          |
| `Enter`                    | Switch to selected session                 |
| `n`                        | Jump to next waiting agent (cycles)        |
| `p`                        | Toggle preview pane                        |
| `s`                        | Send prompt to selected session            |
| `i`                        | Enter passthrough (preview mode)           |
| `y`                        | Approve permission prompt (preview)        |
| `/`                        | Filter sessions by name or project         |
| `x`                        | Kill selected session (confirms first)     |
| `R`                        | Rename selected session                    |
| `g`                        | Toggle repo-group view (sibling worktrees) |
| `o`                        | Open via workmux (managed agents only)     |
| `d`                        | State provenance overlay (why this state?) |
| `?`                        | Help overlay                               |
| `q` or `Esc`               | Quit (or clear filter)                     |

Press `d` on any agent to open a **read-only state-provenance overlay**: the
final state, how Fleet tracked the pane (hook / discovery / shell), the
hook/event/scrape candidates (with hook/event ages), the winning source, the
reason, matched detection rule id, decision timestamps, and whether the
working-timeout fired. It renders the fused `StateDecision` the last refresh
already attached — no live re-scrape — so it agrees with the `--json` observers.
`fleet explain` deliberately re-scrapes the current screen and may be newer.
Press any key to close.

Press `g` to toggle an **opt-in repo-group view**: agents that are sibling
worktrees of the same repository (they share a git common dir) group under a
single repo header instead of grouping by tmux session. It is **off by default** —
default ordering and navigation are unchanged until you press `g`, and toggling
keeps the same agent selected so your cursor position is stable across the
regroup.

Press `o` on a **workmux-managed** agent to focus it via `workmux open`. Fleet
never depends on workmux: the key is only offered when workmux is installed and
claims the pane; managed open failures appear as a bounded tmux message. (Core
detection works identically with or without workmux.)

You can also **click** a session row to select it; clicking a `ready` agent acknowledges it in place (see [Acknowledge](#agent-states)).

### Agent States

Fleet tracks seven states, sorted by urgency. The icon and color tell you what's happening at a glance:

| Icon | State       | Meaning                                                         |
| ---- | ----------- | --------------------------------------------------------------- |
| `⚠`  | **waiting** | Tool approval needed (`[y/n]` prompt)                           |
| `?`  | **asking**  | Agent asked you a question (`AskUserQuestion`)                  |
| `●`  | **ready**   | Turn ended — your move (finished, or asked in prose); green dot |
| `◉`  | **working** | Thinking or running tools                                       |
| `●`  | **idle**    | Up but no recent activity (blue dot)                            |
| `■`  | **shell**   | No agent running (hidden by default)                            |
| `○`  | **down**    | No live process (hidden by default)                             |

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

### Hook-less agents

Fleet also surfaces agents it has **no** hook integration for. On its 5-second refresh it scans the process table for known agent commands — `aider`, `cursor`, `opencode`, `gemini`, `amp`, `droid` (plus `claude`/`codex`/`pi`) — maps each back to its tmux pane, and shows it on the dashboard labeled by type. No install, no config: start `aider` in a pane and it appears within ~5s.

Discovered agents get (nearly) the full status vocabulary, fused from three scrape-tier signals:

- **waiting / asking** — once discovery names the pane's agent, the screen is classified against _that agent's_ detection manifest (a hook-less `opencode` showing `△ Permission required` reads as waiting, not idle) and its **pane-title rules** (Codex retitles to `Action Required` while blocked — caught on the fast 500ms cycle, since the title rides the same `list-panes` call).
- **working** — the animated braille spinner (in the pane or as a title prefix), or the manifest's working rules (token counter, `esc to interrupt`).
- **ready** — synthesized when a discovered agent goes working → idle **while you're not looking at its pane**, and cleared the moment you view it (or when it starts working again). The same "finished while you were elsewhere" semantic hooked agents get from acknowledge, without a hook.

A hooked agent still always wins its pane: when a `.status` file exists, the hooked reading takes over — hooks add tool names, question-vs-permission disambiguation, and authoritative done. Discovery only ever fills the gap where there's no hook.

Tune it with tmux options (see [Configuration](#configuration)): `@fleet_discover off` turns it off, `@fleet_discover_agents` overrides the allowlist, `@fleet_discover_idle_secs` sets the debounce.

### Desktop notifications

When an agent finishes a turn — or stops to ask you something — while you're **not** looking, Fleet fires a **silent** OS-native desktop notification (`osascript` on macOS, `notify-send` on Linux). It's deliberately soundless: at fifteen agents, a chime per finish is noise, not a signal. Delivery is best-effort and no-ops cleanly when there's no desktop session (headless, SSH).

Two suppressions keep toasts from being redundant: none for the pane you're **currently focused on**, and none at all while you're **watching the Fleet dashboard itself** (you can already see the change on screen). A toast fires only on a real working → stopped transition, exactly once, and re-arms when the agent starts working again.

The in-tmux status-line flash still fires as before. The terminal **bell**, though, is now **off by default** — turn it back on with `tmux set -g @fleet_bell on` if you want the audible cue.

## Theming

Fleet ships two state palettes — Catppuccin Mocha for dark terminals, Catppuccin Latte for light ones — and picks between them automatically. You can customize the seven agent-state colors with `${XDG_CONFIG_HOME:-$HOME/.config}/fleet/theme.toml`:

```toml
[colors]
permit = "yellow"
question = "magenta"
done = "green"
busy = "bright-red"
idle = "blue"
shell = "bright-black"
down = "white"
```

Each role is required and accepts one of the 16 ANSI foreground names (`black` through `white`, plus their `bright-` variants) or a six-digit `#rrggbb` value. ANSI colors follow your terminal palette; RGB colors remain fixed, and the two forms can be mixed:

```toml
[colors]
permit = "yellow"
question = "#cba6f7"
done = "green"
busy = "#fab387"
idle = "blue"
shell = "bright-black"
down = "#45475a"
```

This is state-palette customization, not complete UI theming: chrome, style modifiers, pane previews, glyphs, and the tmux status line are unchanged. A missing file is normal. An invalid or unreadable file prints one warning and falls back to automatic selection.

Selection walks this chain and stops at the first hit:

1. **`FLEET_THEME`** — `FLEET_THEME=light` or `FLEET_THEME=dark` forces the theme outright.
2. **tmux option** — `tmux set -g @fleet-theme light` (or `dark`) pins it for every Fleet launched in that tmux server.
3. **Custom state palette** — a valid XDG `theme.toml` selects its ANSI/RGB colors.
4. **Terminal background** — outside tmux, Fleet asks the terminal for its background color (OSC 11), falling back to `COLORFGBG` if the terminal exports it. Current tmux doesn't forward the OSC 11 query, so this rung only fires when you run Fleet directly, not through tmux.
5. **macOS appearance** — inside tmux on a Mac, Fleet follows the system Light/Dark setting. This is the rung that makes auto-switching work in a normal tmux session.
6. Otherwise it defaults to dark (Mocha).

`NO_COLOR` is always honored: set it and Fleet emits no color or styling escape sequences, whatever the theme would have been. It produces plain terminal text; it is not an ANSI-color fallback.

## Configuration

Beyond the theme chain above, Fleet reads a handful of tmux user options — set them live with `tmux set -g <option> <value>` or drop them in `~/.tmux.conf`. All are optional, and changes take effect within one 5-second refresh (no restart).

| Option                      | Default       | Description                                                                                                                                                                             |
| --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fleet-theme`              | auto          | Pin the palette to `light` or `dark` (see [Theming](#theming)).                                                                                                                         |
| `@fleet_bell`               | `off`         | Ring the terminal bell on a cross-session transition. Off keeps Fleet silent at scale; the visual flash fires regardless.                                                               |
| `@fleet_discover`           | `on`          | Discover agents with no hook integration from the process table. Set `off` to disable.                                                                                                  |
| `@fleet_discover_agents`    | built-in list | Comma-separated allowlist of command names to treat as agents. **Replaces** the default `claude,codex,pi,aider,cursor,opencode,gemini,amp,droid`, so keep the built-ins you still want. |
| `@fleet_discover_idle_secs` | `3`           | Grace period (seconds) before a discovered agent flips working → idle, absorbing a single spinner-less frame.                                                                           |

Environment variables `FLEET_THEME` (`light`/`dark`) and `NO_COLOR` are honored too — see [Theming](#theming).

### Custom detection

Each agent classifies its pane against a built-in **detection manifest** (ordered
regex rules, first match wins). You can tune one per agent by dropping a JSON file
at `~/.config/fleet/detection/<agent>.json` (respects `XDG_CONFIG_HOME`). Two
formats are supported:

**1. Override envelope (recommended)** — `schemaVersion: 1`. Inherits a built-in
and applies explicit, stable-id operations on top of it, so you keep Fleet's
field-tested rules and only change what you name:

```jsonc
{
  "schemaVersion": 1,
  // Which built-in to inherit. Optional — defaults to this file's own agent.
  "extends": "claude",
  // Scalar overrides (each optional; omitted keys keep the inherited value):
  "linesFromBottom": 15,
  "promptMarker": "❯",
  "approveKeys": ["1"],
  "denyKeys": ["Escape"],
  // Screen-rule operations (all optional):
  "appendRules": [{ "id": "permit.my-tool", "pattern": "approve MyTool\\?", "flags": "i", "state": "PERMIT" }],
  "replaceRules": [{ "id": "permit.yn", "pattern": "\\[y/n\\]", "state": "PERMIT" }], // swap in place, by id
  "disableRules": ["permit.tab-to-amend"], // remove by id
  // Title-rule operations mirror the screen ones:
  "appendTitleRules": [],
  "replaceTitleRules": [],
  "disableTitleRules": [],
}
```

Rule `state` must be one of `PERMIT`, `QUESTION`, `BUSY`, `IDLE`. `id`s are
stable and must be unique; a duplicate or bad-regex rule is dropped with a
warning (its siblings survive), and `replaceRules`/`disableRules` ids that match
no base rule warn and are ignored. First-match ordering (base rules, then
appended rules) is preserved. An unknown `schemaVersion` or `extends` warns and
falls back to the built-in — detection never throws.

**2. Legacy override** — a file with **no** `schemaVersion` replaces the built-in
manifest **wholesale** (the pre-existing behavior; nothing is inherited).

## CLI Commands

Fleet also works as a non-interactive CLI for scripting and tmux integration.

| Command                                   | Description                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `fleet status [--tmux] <session>`         | Query agent state. `--tmux` outputs a tmux format string for status bars.             |
| `fleet status --statusline`               | Render a full multi-agent status line for tmux's second row.                          |
| `fleet next`                              | Switch to the next waiting agent pane (cycles through PERMIT > QUESTION > DONE).      |
| `fleet switch <pane-id>`                  | Acknowledge a ready agent and switch to it (used by the statusline click binding).    |
| `fleet ack <pane-id>`                     | Acknowledge a ready agent in place (clear it from the attention tier, no switch).     |
| `fleet send <session> <prompt>`           | Send a prompt to a session. Refuses unsafe states unless `--force`.                   |
| `fleet wait <sel...> --state <s>`         | Block until agent(s) reach a state. See [Scripting & JSON API](#scripting--json-api). |
| `fleet list [--json]`                     | List every agent (human roster, or the versioned JSON envelope).                      |
| `fleet status --json [<sel>]`             | Query agent state as JSON, optionally narrowed by a selector.                         |
| `fleet watch [<sel>...] --jsonl`          | Stream state changes as JSON Lines (read-only) until interrupted.                     |
| `fleet capture --pane <sel>`              | Print a pane's current buffer as plain text (read-only). `--json` to wrap it.         |
| `fleet workmux-open <selector>`           | Focus a workmux-managed agent via `workmux open` (read-only; needs workmux).          |
| `fleet doctor`                            | Check tmux version, plugin installation, status directories, hook health.             |
| `fleet reconcile [--dry-run] [--verbose]` | Remove orphan status files for dead panes, fix stale working states.                  |
| `fleet install`                           | Register Fleet as a Claude Code plugin + add second tmux status row.                  |
| `fleet install codex`                     | Wire fleet into Codex's `hooks.json` + `config.toml` (preserves your own hooks).      |
| `fleet install pi`                        | Wire fleet into pi as a package extension (preserves your own packages).              |
| `fleet uninstall`                         | Remove plugin registration + tmux status row.                                         |
| `fleet uninstall codex`                   | Remove fleet's Codex hooks + config (leaves your own Codex hooks intact).             |
| `fleet uninstall pi`                      | Remove fleet's pi extension + registration.                                           |
| `fleet statusline --inject`               | Manually add the second tmux status row.                                              |
| `fleet statusline --remove`               | Manually remove the second tmux status row.                                           |

### Scripting & JSON API

The observability verbs (`list`, `status --json`, `watch`, `capture`, `wait`) are a stable, read-only surface for orchestration. They only read tmux and agent state — they never write status files, acknowledge, or mutate anything.

**Selectors** — one grammar across every verb (first rule that fits wins):

| Selector          | Matches                        | Example     |
| ----------------- | ------------------------------ | ----------- |
| `%<n>`            | a tmux pane id                 | `%42`       |
| `@<n>`            | every pane in a tmux window id | `@5`        |
| `<session>:<win>` | a session **and** window name  | `api:build` |
| `<session>`       | every pane in a session        | `api`       |

**JSON envelope** — agent-listing verbs (`list`, `status`, and watch snapshots) share one versioned shape. `capture --json` uses a command-specific payload with the same `schema`, `outcome`, `queriedAt`, and `selector` base fields:

```json
{
  "schema": "fleet.observe/v1",
  "outcome": "ok",
  "queriedAt": 1737064800000,
  "selector": "api",
  "count": 1,
  "agents": [{ "pane": "%42", "session": "api", "status": "PERMIT", "...": "..." }]
}
```

`watch --jsonl` emits one `type:"snapshot"` envelope, then one `type:"change"` line per transition (`{pane, from, to, agent}`; `from:null` on appearance, `to:null` on disappearance). `capture --json` returns `{schema, outcome, queriedAt, selector, pane, session, lines}`; failures replace the capture fields with `error`.

**Git metadata** (additive, v1) — every agent view carries a read-only `git`
object (or `null` on a non-git dir), refreshed on the slow tick only (zero
fast-tick subprocesses):

```json
{
  "git": {
    "repoId": "/home/u/proj/.git",
    "commonDir": "/home/u/proj/.git",
    "worktreeRoot": "/home/u/proj-feature",
    "branch": "feature",
    "detached": false,
    "head": "a1b2c3d4e5f6789012345678901234567890abcd",
    "dirty": true,
    "staged": 1,
    "unstaged": 2,
    "untracked": 0,
    "ahead": 3,
    "behind": 0,
    "upstream": "origin/feature",
    "diffstat": { "files": 2, "added": 40, "removed": 5 }
  },
  "repoSiblingCount": 1,
  "workmux": { "managed": true, "handle": "proj-feature", "path": "/home/u/proj-feature" }
}
```

`repoId` is the absolute git common dir, shared by every linked worktree of a
repo — so `repoSiblingCount` reports how many other sibling worktrees appear in
the same listing (the current worktree is excluded). The legacy `branch` and
`project` fields are preserved unchanged.
`workmux` is `null` unless workmux is installed and claims the pane; fleet's core
detection never depends on it.

**Outcomes** (the `outcome` field, and what drives exit codes):

| Outcome            | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `ok`               | every requested agent resolved cleanly                     |
| `no_agents`        | tmux answered, but no agents are present at all            |
| `no_match`         | a selector was given and matched nothing (agents exist)    |
| `ambiguous`        | a selector matched multiple panes where one was required   |
| `stale_data`       | tmux is unavailable; a prior snapshot is being reported    |
| `tmux_unavailable` | tmux could not be queried and no cached data was available |

**Exit codes** — scripts pipe on these; the numeric values are part of the contract:

| Code  | Name             | When                                                            |
| ----- | ---------------- | --------------------------------------------------------------- |
| `0`   | OK               | success (`ok`, `no_agents`, and `stale_data` still exit 0)      |
| `1`   | USAGE            | bad or missing arguments                                        |
| `2`   | NO_MATCH         | a selector matched no agent                                     |
| `3`   | AMBIGUOUS        | `capture` selector matched multiple panes                       |
| `4`   | TMUX_UNAVAILABLE | tmux could not be queried                                       |
| `124` | TIMEOUT          | a bounded `wait` crossed its deadline (`timeout(1)` convention) |

**`fleet wait`** blocks until the target state is reached, polling on the dashboard's refresh cadence:

```bash
# Block until any pane in session `api` is ready, giving up after 5 minutes
fleet wait api --state ready --timeout 300

# Wait for BOTH sessions to finish (default is ALL selectors)
fleet wait api db --state ready

# Wait for the FIRST of several to need you, then jump to it
fleet wait api db --state waiting --state asking --any && fleet next
```

States accept display labels or raw names: `ready` (DONE), `waiting` (PERMIT), `asking` (QUESTION), `working` (BUSY), `idle`. Repeat `--state` to accept any of several; pass multiple selectors and `--any` to succeed on the first match instead of all. A selector that matches nothing exits `2`; in `--any` mode, missing selectors are ignored while another selector is still live.

Hook-less `DONE` is observation-relative: long-running `watch`/`wait` processes can see a discovered agent transition from working to ready, while a cold one-shot `status` has no prior frame and reports that same prompt as idle. The JSON `tracking` and `timestampKind` fields make that distinction explicit.

```bash
# Live change stream for a session, one JSON object per line
fleet watch api --jsonl

# One-shot machine-readable snapshot of everything
fleet list --json | jq '.agents[] | select(.needsAttention)'

# Read a pane's screen without touching it
fleet capture --pane %42 --lines 100
fleet capture --pane %42 --json | jq '.lines'
```

### Tmux Status Bar Integration

Fleet supports two levels of tmux integration:

**Second status row (recommended):** A dedicated row showing all agents that need attention, with clickable entries. Set up automatically by `fleet install`, or manually:

```bash
fleet statusline --inject
```

Each entry is clickable (tmux 3.2+). **Left-click** an agent name to switch to that session; **right-click** to mark it read in place without switching. When any agent is ready, a `✕ clear` chip appears at the end of the row — click it to dismiss every ready agent at once. Only agents whose turn it is for you appear: PERMIT (tool approval), QUESTION (a question to answer), and DONE/ready (finished, waiting on your next move). Working and idle sessions stay out of the bar — they don't need you to act, so they'd just be noise. Watch those in the dashboard instead.

**The `☰` button** sits at the far left of the row and is always there, even when no agent needs you. Click it (either mouse button) to open the dashboard in a 34-column sidebar split; click again to close it. It toggles the window you're looking at, so it does the right thing with several clients attached to different windows. Same thing as `prefix+f`, minus the keyboard — and the same as `fleet sidebar`, which you can bind however you like.

(After upgrading Fleet, re-run `fleet statusline --inject` to pick up the right-click binding, clear chip, focus-to-clear hook, and `☰` button.)

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

3. **Pane scraping** (Layer 3, ~50ms) — `tmux capture-pane` as the visual arbiter. Detects permission prompts (`[y/n]`), question dialogs (`Enter to select`), the working token counter (`(1m 11s · ↓ 3.4k tokens)`), the animated **braille spinner glyph** (U+2800–U+28FF), and idle prompts. The spinner is a strong working signal: a harness paints it only while actually working, so — unlike the English strings — it can't be spoofed by a transcript that quotes them, and it still reads as working after the token-counter line scrolls off. Detection is an ordered, first-match-wins rule list. For Claude the **live-only working indicators** (token counter, `esc to interrupt`) are checked _before_ the prompt rules: they vanish whenever a real dialog is up, so a genuine prompt still reads `PERMIT`/`QUESTION`, while an already-answered prompt lingering on screen during the next tool run correctly reads working instead of a false "waiting". The weaker spinner-glyph rule stays last, so a glyph co-present with a real `[y/n]` never hides it. For working-vs-idle the scraper defers to the hooks — a scraper miss can't downgrade a fresh `working` hook to idle — but a scraped idle prompt does clear a stale permission. (The same spinner check drives [hook-less discovery](#hook-less-agents) for agents with no hook at all.)

   Manifests can also carry **title rules**, matched against `#{pane_title}` instead of the screen. The title comes free with the fast cycle's one `list-panes` call, so title-sourced state lands in ~500ms instead of waiting for the ~5s scrape: Codex's `Action Required` title reads `PERMIT` (covering its missing Notification hook), and the braille title prefix Claude/Codex paint while working reads `BUSY`.

**Freshness invariant:** A state transition is only accepted if its timestamp is newer than the current state's timestamp. Prevents out-of-order hook deliveries from causing flicker.

**Verify on switch:** When you navigate to a pane (Enter or click), Fleet scrapes it immediately and updates the status file. Stale states get corrected the moment you look at them.

**Acknowledge:** Once you've seen a `ready` agent it drops to `idle` and leaves the attention tier (and the statusline). Ways to acknowledge:

- **Click it in the dashboard** — acknowledges in place, so you can clear several finished agents without leaving Fleet.
- **Switch to it** (Enter, or left-click its statusline entry) — acknowledges, then takes you there.
- **Focus its pane any other way** — reaching the pane through tmux itself (prefix keys, clicking the pane, `choose-tree`) clears it too, via a `pane-focus-in` hook, so you don't have to go through Fleet. Only a lingering `ready` chip clears this way; a pending `PERMIT`/`QUESTION` stays until you answer it on screen.
- **Right-click its statusline entry** — acknowledges in place, without switching.
- **Click the `✕ clear` chip** at the end of the statusline — acknowledges every ready agent at once.
- **`fleet ack <pane>`** — from the CLI, for scripting or bulk-clearing.

A ready agent's completion can come from two independent places: the hook status file (`done`/`completed`) or an event-derived turn-end (a `Stop`/`SubagentStop` the status file may not reflect yet — the bar shows `ready` from the event stream while the file lags at `idle`). Acknowledgement retires both: it flips a ready status file to `idle`, and when the event stream shows a completion it appends an `Acknowledged` event so the derived `ready` can't re-assert. It survives Fleet restarts with no separate store. So: green `ready` = needs your eyes; blue `idle` = seen, nothing pending.

**Decay:** `ready` never auto-decays — a finished turn is waiting on you and stays until you act on it (switch to it, send a prompt, or it starts working again). Only `working` times out to `idle`, after 3 minutes, so a crashed turn doesn't spin forever.

### Hook Details

The Claude Code plugin (`hooks/`) fires on five events:

- **Notification** — Splits into three sub-types: `permission_prompt` → permit, `elicitation_dialog` → question, `idle_prompt` → ready
- **PreToolUse** — Agent is running a tool (working). The `AskUserQuestion` tool is the exception — it means the agent is asking _you_, so it maps to **asking**, not working.
- **Stop** — Agent stopped. `tool_use` stop reason = still working. `end_turn` = turn over (ready). Background tasks suppress completion. 3-second grace period.
- **SubagentStop** — Subagent finished; parent keeps working
- **SessionEnd** — Cleanup status and event files

Each hook script sources `hooks/lib.sh` which handles status file writes, JSONL event appends, and the in-tmux notification flash (with self-notification suppression). The flash always fires; the terminal bell it used to ring is now gated behind `@fleet_bell` (default off — see [Configuration](#configuration)). The silent desktop toasts are fired separately by the TUI, not the hooks (see [Desktop notifications](#desktop-notifications)).

### Performance

The TUI separates cheap and expensive operations:

- **Every 500ms:** Re-read `.status` files + one `tmux list-panes` call + JSONL last-line read. No subprocesses beyond that.
- **Every 5s:** Refresh port detection (`lsof`), pane scraping (`tmux capture-pane` per pane, ~50ms each), and one global `workmux status --json` spawn when workmux is installed.
- **Every 10s:** Refresh read-only git metadata with bounded, lock-free `git` argv spawns per unique pane cwd (identity, worktree root, branch/dirty/ahead-behind, diffstat). Zero git/workmux subprocesses on the fast tick.
- **On keypress:** Zero subprocess calls. Just redraws from cached state.
- **On switch:** Scrapes the target pane and corrects the status file before switching. Stale states are fixed the moment you navigate to them.
- **During send/filter:** All refresh timers pause. The event loop is yours.
- **JSONL reads:** Only the last line is parsed (not the entire file).

## Agent Configuration

Fleet reads agent directories from (in priority order):

1. `~/.config/fleet/agents.json` (new format)
2. `~/.config/agent-status/agents.conf` (legacy format)
3. Hardcoded fallback: `~/.cache/claude-status` + `~/.cache/codex-status` + `~/.cache/pi-status`

### New format (`agents.json`)

```json
{
  "agents": [
    { "name": "claude", "statusDir": "~/.cache/claude-status" },
    { "name": "codex", "statusDir": "~/.cache/codex-status" }
  ]
}
```

### Legacy format (`agents.conf`)

```ini
# name=directory
claude=$HOME/.cache/claude-status
pi=$HOME/.cache/pi-status
```

This file is only for **hooked** agents — ones that write status files. Agents picked up by [hook-less discovery](#hook-less-agents) need no entry here; they're found in the process table.

## Development

Fleet is a zero-dependency Bun project.

```bash
bun install              # Install dev dependencies
bun run dev              # Run without compiling
bun run build            # Compile to standalone binary (dist/fleet)
bun test                 # Run tests (921 tests)
bun run typecheck        # tsc --noEmit
bun run lint             # oxlint
bun run format           # oxfmt
bun run format:check     # oxfmt --check
```

### Testing

Tests are collocated (`*.test.ts` next to source). The state engine, ANSI utilities, TUI model, and CLI commands are unit-tested. Tmux-dependent code has integration-style tests that gracefully degrade outside tmux.

```bash
bun test                 # Full unit suite
bun test src/state/      # State engine only
bun test src/terminal/   # Terminal primitives only
bun test src/tui/        # TUI model only
bun test src/cli/        # CLI commands
```

## Demo video

https://github.com/user-attachments/assets/2a9ce8db-767e-4260-a0e4-0a61562acef7

## License

MIT
