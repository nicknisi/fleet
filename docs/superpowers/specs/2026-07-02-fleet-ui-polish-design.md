# Fleet UI Polish — Design

- **Date:** 2026-07-02
- **Status:** Approved in brainstorm; awaiting implementation plan
- **Scope:** Adaptive theming, responsive sidebar layout, state signaling, install ergonomics

## Goal

Bring next-level visual polish to fleet without changing what fleet is: a zero-dependency
dashboard that runs *inside* a tmux pane and reads state written by hooks. Fleet does not
wrap tmux. The "sidebar" experience (inspired by jmux) comes from tmux hosting a narrow
fleet pane, with fleet reflowing its layout to fit the width it's given. One binary, one
responsive renderer — no `--sidebar` flag.

## Constraints

- Zero runtime dependencies; compiled standalone binary (unchanged)
- No tmux wrapping, no PTY ownership, no control-mode client
- Plain Unicode glyphs only; no nerd-font requirement
- Single-string-per-frame rendering stays (`src/tui/render.ts`)
- `NO_COLOR` and non-TTY color behavior unchanged (`src/terminal/colors.ts:1-12`)
- Restrained motion: **no new timers** — animation rides the existing 500ms fast tick
- Fleet never paints background colors; the terminal default shows through. All theming
  is foreground-only.

## 1. Adaptive theme — `src/terminal/theme.ts` (new)

Today the state palette is hardcoded Catppuccin Mocha truecolor
(`src/terminal/colors.ts:61-83`), which is illegible on light terminals — the same
problem already fixed for the tmux statusline in PR #15, but never fixed in-app.

**Design:**

- At startup (TTY + colors enabled only), emit an OSC 11 query (`ESC ] 11 ; ? ST`) and
  parse the reply from stdin. Compute Rec.709 luminance from the reported background.
- Dark background → Mocha (current palette). Light → Catppuccin Latte equivalents.
  Chrome (dim text, borders, header, `gray`) stays on **named ANSI codes**, which the
  terminal's own palette already adapts — only the truecolor state palette swaps.
- **Detection chain** (first hit wins; each rung is a small pure-testable function):
  1. `FLEET_THEME` env var (`light` | `dark`) — explicit, instant
  2. `tmux show -gqv @fleet-theme` — durable user override, tmux-native
  3. OSC 11 query, 150ms timeout — live when fleet runs outside tmux or a future
     tmux forwards it (see resolved risk below)
  4. `COLORFGBG` env heuristic (background field ≤ 6 or 8 → dark; 7 and 9–15 → light)
  5. macOS only: `defaults read -g AppleInterfaceStyle` (`Dark` → dark; anything
     else/error → light)
  6. Default: dark (Mocha) — today's exact behavior
- Reply timeout: 150ms. The query races the timeout before the first render; startup is
  already a synchronous full refresh, so worst case adds 150ms once.
- **Input-layer integration (the one sharp edge):** the OSC reply arrives on stdin,
  interleaved with real keystrokes, possibly split across reads. The stdin handling in
  `src/terminal/input.ts` must recognize and swallow `ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL|ST)`
  — buffering incomplete sequences — so a fast typist at launch never sees reply bytes
  leak in as input. Non-OSC bytes received while waiting are replayed to the normal key
  path, not dropped.
- API: `initTheme(): Promise<Theme>`; `Theme` carries state colors + derived chrome +
  `isDark`. `colors.ts` consumers switch from module constants to the active `Theme`.

**Risk — RESOLVED by live spike (2026-07-02):** on the reference setup (tmux 3.7a,
Ghostty 1.3.1, macOS) an OSC 11 query from inside a pane gets **no reply** (0 bytes in
600ms), `#{client_bg}` is not a supported format, and `COLORFGBG` is unset — while
`AppleInterfaceStyle` reads `Dark` correctly. Hence the chain above: the OS-appearance
rung is what auto-adapts on macOS today; the OSC rung stays for outside-tmux runs and
future tmux versions; `@fleet-theme`/`FLEET_THEME` cover everything else.

## 2. Responsive layout — `src/tui/layouts/` (new)

- Breakpoint constant `CARD_LAYOUT_MAX_COLS = 48` (single tunable const). Width below it
  → card layout; at or above → today's table.
- Extract the current table row rendering from `src/tui/dashboard.ts` into
  `layouts/table.ts`; add `layouts/cards.ts`. Both consume the existing row model from
  `src/tui/app.ts` — the row model contract is unchanged by layouts (the only model
  addition in this design is the `tmuxDown` flag in §3).
- **Card = 2–3 lines per agent:** `icon name … age` / `branch · agent-type` / state
  detail (current tool, "permission prompt", …) only when present. Selection bar `▌`
  spans the card. Session group headers become thin separators in card mode.
- Footer collapses to `? help` in card mode. Preview stays gated to ≥120 cols
  (unchanged); in sidebar life, Enter jumps to the agent's pane — the pane is the preview.

```
│ FLEET        2 need you │
│─────────────────────────│
│ ▌⚠ api-server        4s │
│ ▌  feat/auth · claude   │
│ ▌  permission prompt    │
│                         │
│ ◉ jmux-spike         2m │
│    spike/ui · codex     │
│ ● blog              12m │
│ ↓ 2 more                │
```

## 3. Signal polish (both layouts)

- **Header summary strip:** colored counts, e.g. `2 need you · 1 busy · 3 idle`,
  replacing the current plain header text.
- **Busy pulse:** BUSY icon `◉` alternates normal/dim each fast tick. The tick must set
  `needsRender` when any BUSY row is visible and the pulse phase flips; no new timers.
- **Hover highlight:** mouse motion events are already parsed (`src/terminal/mouse.ts`),
  but the current mouse mode (`?1002`) only reports motion while a button is held —
  hover requires enabling any-event tracking (`?1003`) alongside it. Render the hovered
  row's name underlined (foreground-only). Extract
  the row hit-testing math from `index.ts:629-653` into a pure, tested module as part of
  this change.
- **Scroll indicators:** `↑ N more` / `↓ N more` lines when the agent list overflows the
  viewport.
- **Distinct empty states** replacing the single ambiguous "No agents found"
  (`src/tui/dashboard.ts:50-53`):
  1. *tmux unreachable* — requires `listPanes()` (`src/tmux/sessions.ts:16-17`) to stop
     collapsing errors into `[]`; it must distinguish failure from genuinely-empty, and
     the app model gains a `tmuxDown` flag. Message says tmux isn't running.
  2. *No hooks installed* (status dir absent — reuse the `fleet doctor` check) — message
     points at `fleet doctor` / `fleet install`.
  3. *All quiet* — a deliberate, styled idle state, not an error-shaped one.

## 4. Sidebar ergonomics

- `fleet install` gains two optional tmux keybindings — open fleet in a 32-col split,
  and `tmux display-popup -E fleet` (the popup/overlay form factor falls out for free).
  Applied through the same mechanism install already uses for the status row, gated by
  a per-binding confirm; declining prints the snippet for manual use.
- No changes to interaction model: Enter/click jumps to the agent's pane; statusline
  chips and acks behave exactly as today.

## Error handling

Every new capability degrades to current behavior: OSC failure → Mocha; motion events
absent → no hover; narrow-width math errors are impossible by construction (cards are
fixed-line templates truncated by the existing ANSI-aware width helpers in
`src/terminal/ansi.ts`). No new failure modes are user-visible as errors.

## Testing

- `theme.ts` (luminance math, reply parsing incl. split reads, fallback chain),
  breakpoint selection, and card composition are pure functions → unit tests beside the
  existing suite.
- Row hit-testing extraction brings the first tests to what is currently untested
  `index.ts` mouse math.
- Manual verification matrix: dark terminal, light terminal, `NO_COLOR`, non-TTY,
  narrow pane (32 cols), wide pane, tmux popup.

## Out of scope (deliberate)

- Row-level frame diffing (current no-clear + erase-line single-write is flicker-free;
  revisit only if SSH bandwidth becomes a real complaint)
- Nerd-font icon sets
- Config file system (separate effort; a `theme: auto|dark|light` override joins it
  when it exists)
- Command palette, multi-pane preview grid, session snapshots (jmux features that don't
  fit fleet's role)

## Implementation phasing (input to the plan)

1. OSC 11 spike through tmux; `theme.ts` + input-layer OSC swallowing; palette swap
2. Distinct empty states + header summary strip
3. Card layout + breakpoint + footer collapse
4. Hover (with hit-test extraction), scroll indicators, busy pulse
5. Install snippets (sidebar split + popup binding); README/screenshot updates

## Sources

Code locations cited above were verified by codebase exploration on 2026-07-02 (fleet
and jmux architectural maps). jmux techniques referenced: OSC 11 adaptive theme
(`jmux/src/theme.ts:85-96,167-181`), state-colored sidebar cards (`jmux/src/sidebar.ts`).
