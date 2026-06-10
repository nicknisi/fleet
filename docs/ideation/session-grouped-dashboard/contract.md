# Session-Grouped Dashboard & Window-Name Statusline Contract

**Created**: 2026-06-10
**Readiness Gates**: 5/5 ready
**Status**: Approved (Stretch scope)
**Supersedes**: None

## Problem Statement

The fleet dashboard labels each agent with a `session:window` string truncated at a fixed 15 characters, so with multiple agents per tmux session every row reads like `authkit:🤖 wor…` — the window name, the part that actually distinguishes agents, is the part that gets cut off (screenshot from 2026-06-10, 8 agents).

The tmux second statusline renders the raw session name per chip (`src/cli/status.ts:26`), never adopting the window-aware labels shipped in v0.7.0 (PR #11), so two ready agents in the same session produce identical chips and the user can't tell which window needs attention.

## Goals

1. Dashboard rows are grouped under session header lines, with window names rendered in full (untruncated) at typical terminal widths.
2. Groups order by their most urgent member so attention-needing agents still bubble to the top; rows within a group order by urgency then window name.
3. Statusline chips show the window name (falling back to the session name when the window name is empty or equals the session name).
4. Preview header and kill confirmation use the same window-first labeling rule.

## Success Criteria

- [ ] `bun test` passes, including new cases: a session with 2+ agents renders a header line plus indented agent rows; a single-agent session renders one inline `session · window` row with no header.
- [ ] Group ordering: a session containing a PERMIT agent sorts above a session whose best status is DONE, regardless of alphabetical order. Within-group: a PERMIT row renders above a DONE row in the same group; equal-status rows order by window name.
- [ ] Width: at 120 and 80 columns, a 20-char window name renders untruncated; when narrowing, the detail column shrinks to its minimum and the branch column drops before the window name loses any character.
- [ ] Statusline: `formatStatusLine` renders the window name per chip and falls back to the session name when the window is empty or equals the session name; click ranges (paneId) are unchanged.
- [ ] Preview header and kill confirmation tests assert the window-first label.
- [ ] `bun run typecheck` and `bun run lint` pass.
- [ ] Navigation (j/k) and selection skip header lines; the `/` filter hides groups with no matching rows.

## Scope Boundaries

### In Scope (approved tier: Stretch = MVP + Stretch; Full tier is empty)

- Grouped dashboard rendering: session header lines, 2-space-indented agent rows, inline singleton rows
- Urgency-bubbled group ordering; urgency-then-window ordering within groups
- Content-sized window column with shrink order detail → branch → window last; all width math uses the existing `visibleLength()` helper so emoji-prefixed window names pad correctly
- Statusline chips: window name with session fallback
- Preview header and kill confirmation adopt window-first labels
- Navigation/selection skip headers; filter hides empty groups
- Header line shows per-session agent count and aggregate status icon _(stretch)_

### Out of Scope

- Collapsible/expandable session groups — interaction-model change beyond the readability fix; revisit if session counts grow
- User-configurable sort modes — urgency-bubbled grouping was chosen explicitly; no evidence a toggle is needed
- Pane-level rows (multiple agents in one window) — state engine keys agents by pane already; the display unit chosen is the window

### Future Considerations

- Collapsible session groups with persisted state
- Session-scoped actions on header rows (kill all, ack all)

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Phase 1: Grouped dashboard & window-name labels  (single phase)
```

### Execution Steps

**Strategy**: Sequential

1. **Phase 1** — Grouped dashboard & window-name labels _(blocking, medium risk)_

   Prereq sub-step inside the phase: introduce the row model (header vs agent rows) decoupling rendered-row index from `visibleStates()` index in `app.ts` before the grouping render lands.

   ```bash
   /ideation:execute-spec docs/ideation/session-grouped-dashboard/spec.md
   ```

---

_This contract was generated from brain dump input and approved at Stretch scope on 2026-06-10._
