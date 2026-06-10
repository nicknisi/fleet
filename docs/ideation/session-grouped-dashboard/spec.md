# Implementation Spec: Session-Grouped Dashboard & Window-Name Statusline

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Replace the dashboard's flat `session:window`-labeled rows with a grouped row model: sessions with 2+ agents render a header line followed by indented agent rows showing only the window name; single-agent sessions render one inline `session · window` row. The core refactor is a `DashboardRow` discriminated union (`header` | `agent`) built in `TuiApp`, which decouples _rendered line index_ from _selectable state index_ — the prerequisite named in the contract, since `selectedIndex` currently indexes 1:1 into `visibleStates()` and header lines would break that mapping.

Ordering preserves the dashboard's attention-first purpose: `visibleStates()` is redefined to grouped order — groups sort by their most urgent member (then session name), rows within a group sort by urgency then window name. Because `visibleStates()` keeps returning the flat agent list in exactly the rendered order, `selectedIndex`, `moveUp/moveDown`, `selectedState()`, and the paneId re-anchor in `updateStates()` all keep their existing semantics untouched; only scroll math and the selected-row highlight move to row-space.

Labeling consolidates on a new `windowLabel()` helper in `src/state/types.ts` (window name, falling back to session when the window is empty **or equals the session**) used by the statusline chips, preview header, and kill confirmation. All dashboard width math switches from `String.length` to the existing `visibleLength()` in `src/terminal/ansi.ts` so emoji-prefixed window names (🤖, 🖥 = 2 cells) pad correctly. The name column is content-sized (no fixed 15); when the terminal narrows, the detail column shrinks to its 8-char floor first, then the branch column drops entirely, and only then may the window name truncate (the existing `truncateAnsi` row clamp is the last resort).

## Feedback Strategy

**Inner-loop command**: `bun test src/tui` (collocated TUI tests, runs in ~1s)

**Playground**: Test suite first (`src/tui/dashboard.test.ts`, `src/tui/app.test.ts` drive the row model with fixture states); `bun run dev` inside a tmux session with 2+ windows for visual confirmation.

**Why this approach**: Every component is pure string/array logic over `AgentState[]` fixtures — the test runner is the tightest loop; the live TUI is only needed for final visual checks (alignment, colors).

## File Changes

### New Files

| File Path                   | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `src/tui/dashboard.test.ts` | Tests for row building, grouping, column sizing, shrink order, scroll-in-row-space |

### Modified Files

| File Path                   | Changes                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state/types.ts`        | Add `windowLabel(state)` helper; keep `sessionLabel` (still used by `/` filter context and tests)                                                        |
| `src/state/types.test.ts`   | Cases for `windowLabel`: normal, empty window, `window === session`                                                                                      |
| `src/tui/app.ts`            | Grouped ordering in `visibleStates()`; new `dashboardRows()` returning `DashboardRow[]`; selected-row index helper                                       |
| `src/tui/app.test.ts`       | Group ordering (inter- and intra-group), singleton inline, filter hides empty groups, selection skips headers                                            |
| `src/tui/dashboard.ts`      | Render `DashboardRow[]`: header lines, indented agent rows, inline singletons; content-sized columns via `visibleLength`; shrink order; scroll over rows |
| `src/tui/render.test.ts`    | Frame-level assertions updated for grouped layout                                                                                                        |
| `src/terminal/ansi.ts`      | Add `padAnsi(value, width)` (pad by visible width) and width-aware `truncateWidth(value, maxWidth)` plain-text truncator with `…`                        |
| `src/terminal/ansi.test.ts` | Cases for `padAnsi`/`truncateWidth` with emoji and ANSI codes                                                                                            |
| `src/cli/status.ts`         | `formatStatusLine` chip label: `windowLabel(s)` instead of `s.session`                                                                                   |
| `src/cli/status.test.ts`    | Chip shows window name; falls back when empty or equal to session; paneId ranges unchanged                                                               |
| `src/tui/preview.ts`        | Title uses `windowLabel(state)` with session as secondary context                                                                                        |
| `src/tui/preview.test.ts`   | Assert window-first title                                                                                                                                |
| `src/tui/kill.ts`           | Confirmation label uses `windowLabel(state)` with session context                                                                                        |
| `src/tui/kill.test.ts`      | Assert window-first confirmation                                                                                                                         |

### Deleted Files

None.

## Implementation Details

### 1. `windowLabel` helper (`src/state/types.ts`)

**Pattern to follow**: `sessionLabel` at `src/state/types.ts:73-76` (same shape, inverse preference).

**Overview**: Single labeling rule for "what do I call this agent when the window is the unit of identity."

```typescript
// Window-first label: the window name is what distinguishes agents; the
// session is the fallback when the window adds no information.
export function windowLabel(state: AgentState): string {
  if (state.window.length === 0 || state.window === state.session) return state.session;
  return state.window;
}
```

**Key decisions**:

- Falls back on `window === state.session` (not just empty) — covers tmux auto-named windows; this is the duplicate-chip case from the contract.
- `sessionLabel` stays exported; `displayName` unchanged.

**Implementation steps**:

1. Add `windowLabel` + doc comment next to `sessionLabel`.
2. Add the three test cases in `types.test.ts`.

(Trivial component — no feedback loop beyond the test cases.)

### 2. Row model + grouped ordering (`src/tui/app.ts`)

**Overview**: The prerequisite refactor. `visibleStates()` adopts grouped order; a new `dashboardRows()` interleaves header rows; selection stays state-indexed.

```typescript
export type DashboardRow =
  | { kind: 'header'; session: string; count: number; aggregate: AgentStatus }
  | { kind: 'agent'; state: AgentState; grouped: boolean }; // grouped → indented, window-only name

// Grouped order: groups by most-urgent member (then session); within a
// group by urgency, then window name.
visibleStates(): AgentState[]   // same signature, new ordering
dashboardRows(): DashboardRow[] // derived from visibleStates()
selectedRowIndex(): number      // row index of visibleStates()[selectedIndex]
```

**Key decisions**:

- `visibleStates()` returns the flat list in rendered order, so `selectedIndex`, `moveUp/moveDown`, `selectedState()`, `updateStates()` paneId re-anchor, and `clampSelection()` need **zero changes**. Headers are render-only artifacts, inherently unselectable.
- Group ordering falls out of a two-pass sort: sort states by `compareStatus` then session (existing `sortedStates()`); a session's first appearance in that list _is_ its most-urgent rank, so group order = order of first appearance. Within each group, re-sort members by `compareStatus`, then `windowLabel` comparison.
- `aggregate` on the header = the group's most urgent member's status (drives the stretch-scope icon and header color).
- Filter needs no group logic: `applyFilter` keeps filtering states; a fully-filtered-out session simply produces no rows.

**Implementation steps**:

1. Write failing tests in `app.test.ts`: PERMIT-containing session sorts above DONE-only session regardless of alphabetics; within a group PERMIT row precedes DONE row; equal-status rows order by window name; singleton produces one `agent` row with `grouped: false`; 2+ agents produce `header` + `grouped: true` rows; filtering away all of a session's agents removes its header.
2. Implement grouping in `visibleStates()` (extract a private `groupedOrder()`).
3. Implement `dashboardRows()` and `selectedRowIndex()`.

**Feedback loop**:

- **Playground**: fixture builder in `app.test.ts` (already exists for current tests — extend with `window` variations).
- **Experiment**: 0 sessions, 1 singleton, 1 group of 3, mixed singleton+group, all-same-status group, two sessions tied on urgency.
- **Check command**: `bun test src/tui/app.test.ts`

### 3. Width-aware text helpers (`src/terminal/ansi.ts`)

**Pattern to follow**: `visibleLength` / `truncateAnsi` at `src/terminal/ansi.ts:34-90`.

**Overview**: `padAnsi(value, width)` pads with trailing spaces up to a _visible_ width; `truncateWidth(value, maxWidth)` truncates plain text by visible width appending `…` (replacing `dashboard.ts`'s private `.length`-based `truncate`).

**Key decisions**:

- `padAnsi` never truncates — callers truncate first. Keeps each function single-purpose.
- `truncateWidth` reserves 1 cell for `…` like the current helper, but counts cells via `charWidth` so a 🤖 costs 2.

**Implementation steps**:

1. Tests: emoji string pads to alignment with ASCII string; ANSI-colored string pads by visible width; truncation never splits a surrogate pair.
2. Implement both on top of `visibleLength`/`truncateAnsi`.

**Feedback loop**:

- **Playground**: `src/terminal/ansi.test.ts`.
- **Experiment**: `'🤖 workos'` (width 9) vs `'workos'` (width 6); colored input; `maxWidth` 0, 1, exact-fit.
- **Check command**: `bun test src/terminal/ansi.test.ts`

### 4. Grouped dashboard rendering (`src/tui/dashboard.ts`)

**Pattern to follow**: existing `formatSessionRow` at `src/tui/dashboard.ts:66-96` (colors, chips, `truncateAnsi` clamp).

**Overview**: `renderSessionList` iterates `app.dashboardRows()`; column widths are computed once per frame from the visible rows.

```typescript
interface ColumnWidths {
  name: number; // max visible width of any row's name cell
  detail: number; // flexes, floor 8
  branch: number; // 12, or 0 when dropped
}

// name cell per row kind:
//   header:            `{icon} {session} · {count}`        (not part of name-col sizing; header spans the row)
//   agent (grouped):   `  {window}`                         (2-space indent + windowLabel)
//   agent (singleton): `{session} · {window}`               (or just session when windowLabel === session)
```

**Key decisions**:

- **Column sizing**: `name = max(visibleLength(nameCell))` over agent rows only (headers span the full row). `detail = cols − fixed − name`, floor 8. If `detail` would go below 8, set `branch = 0` (drop the column entirely, freeing 13 cells) and recompute. Only if `detail` is still below 8 does the name cell truncate (via `truncateWidth`) — this is the contracted shrink order: detail → branch → window last.
- **Header line**: `{aggregateColor}{aggregateIcon} {bold}{session}{reset} {dim}· {count} agents{reset}` — stretch scope (count + aggregate icon) lands directly here.
- **Selection**: a row is selected when `row.kind === 'agent' && row.state.paneId === app.selectedState()?.paneId` — no index comparison against loop position.
- **Scroll**: `calculateScroll` now takes `app.selectedRowIndex()` and `rows.length`; it scrolls in row-space so headers count as lines and the selected row stays centered. Accepted edge: a group's header can scroll off while its rows remain visible.
- All cell padding/truncation goes through `padAnsi`/`truncateWidth`; the final `truncateAnsi(row, cols)` clamp stays.

**Implementation steps**:

1. Failing tests in `dashboard.test.ts` rendering fixed-width frames: grouped session → header + 2 indented rows; singleton inline; 20-char window untruncated at 120 and at 80 cols; at a width where detail would drop below 8, branch column disappears before any window character does; emoji and non-emoji window names align in the same frame.
2. Implement column-width computation (pure function, exported for tests).
3. Rewrite `renderSessionList`/`formatSessionRow` over `DashboardRow`.
4. Update `render.test.ts` frame snapshots.

**Feedback loop**:

- **Playground**: `dashboard.test.ts` fixtures; then `bun run dev` in a tmux session with 🤖-named windows.
- **Experiment**: cols ∈ {80, 120, 38 (minimum sensible), 19 (too-small path)}; window names of length 3, 20, 0; mixed emoji/ASCII.
- **Check command**: `bun test src/tui/dashboard.test.ts`

### 5. Statusline chips (`src/cli/status.ts`)

**Overview**: One-line label change in `formatStatusLine` (line 26): `#[bold]${s.session}#[nobold]` → `#[bold]${windowLabel(s)}#[nobold]`.

**Key decisions**:

- `#[range=user|${s.paneId}]` wrappers and the `ACK_ALL_RANGE` clear chip are untouched — click-to-switch keeps working because identity is the paneId, not the label.
- `formatPlainStatus` / `formatTmuxStatus` stay session-scoped (they answer "this session's status", not "which window").

**Implementation steps**:

1. Tests in `status.test.ts`: chip shows window name; empty window → session; `window === session` → session; range markers unchanged.
2. Apply the one-line change.

**Feedback loop**:

- **Playground**: `status.test.ts`; live check via `fleet status --statusline` inside tmux.
- **Experiment**: two DONE agents in one session with different windows must render distinguishable chips (the exact failure from the problem statement).
- **Check command**: `bun test src/cli/status.test.ts`

### 6. Preview header & kill confirmation (`src/tui/preview.ts`, `src/tui/kill.ts`)

**Overview**: Same window-first rule, session kept as secondary context.

```typescript
// preview.ts:37 — was: `${display.icon} ${sessionLabel(state)} · ...`
const where = windowLabel(state) === state.session ? state.session : `${windowLabel(state)} [${state.session}]`;
const title = `${display.icon} ${where} · ${display.label.toUpperCase()}${claudeInfo}${modeTag}`;

// kill.ts:26 — same `where` rule, keeping the existing claudeName suffix
```

**Key decisions**: session in brackets (not `session:window`) so the window reads first; collapse to bare session when the label would duplicate it.

**Implementation steps**: failing assertions in `preview.test.ts` / `kill.test.ts`, then apply; extract the `where` rule into `windowLabel`-adjacent helper only if it ends up needed in 3+ places (it's 2 — inline is fine).

(Small component — covered by its test files; no separate loop.)

## Data Model

No persistent state changes. `AgentState` already carries `window` (`src/state/types.ts:53`). New transient type:

```typescript
export type DashboardRow =
  | { kind: 'header'; session: string; count: number; aggregate: AgentStatus }
  | { kind: 'agent'; state: AgentState; grouped: boolean };
```

## Testing Requirements

### Unit Tests

| Test File                                         | Coverage                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/state/types.test.ts`                         | `windowLabel` fallback matrix                                                                  |
| `src/tui/app.test.ts`                             | Group/intra-group ordering, singleton rows, header derivation, filter, selection-skips-headers |
| `src/tui/dashboard.test.ts`                       | Column sizing, shrink order, emoji alignment, scroll in row-space                              |
| `src/tui/render.test.ts`                          | Full-frame snapshots with grouped layout                                                       |
| `src/terminal/ansi.test.ts`                       | `padAnsi`, `truncateWidth`                                                                     |
| `src/cli/status.test.ts`                          | Chip label + fallback, ranges intact                                                           |
| `src/tui/preview.test.ts`, `src/tui/kill.test.ts` | Window-first labels                                                                            |

**Key test cases** (from contract success criteria):

- Session with 2+ agents → header line + indented rows; single-agent session → one inline row, no header.
- PERMIT-containing session above DONE-only session regardless of alphabetical order; PERMIT row above DONE row within a group; equal statuses order by window name.
- 20-char window name untruncated at 120 and 80 cols; detail shrinks to 8 then branch drops before window loses a character.
- `formatStatusLine`: window name per chip; session fallback on empty and on `window === session`; paneId ranges byte-identical.
- j/k navigation never lands on a header (selection is state-indexed, assert `selectedState()` is always an agent).
- `/` filter that matches no agents in a session removes that session's header.

### Manual Testing

- [ ] `bun run dev` in tmux with ≥2 sessions, one having 2+ 🤖-named windows: headers, indentation, alignment, urgency bubbling.
- [ ] Narrow the pane below ~60 cols: branch column drops before window names truncate.
- [ ] `fleet statusline --inject` active: chips show window names; left-click switches to the correct pane; right-click acks.
- [ ] Kill prompt (`x`) and preview header (`p`) show window-first labels.

## Error Handling

| Error Scenario                                    | Handling Strategy                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Window name empty (pane outside a named window)   | `windowLabel` falls back to session; inline row renders bare session                                                      |
| All sessions are singletons                       | Degenerates to a flat list — visually close to today's layout, by design                                                  |
| Terminal narrower than minimum (`cols < 20`)      | Existing `render.ts` "Terminal too small" path, unchanged                                                                 |
| Selected agent's session regrouped between frames | `updateStates` re-anchors by paneId against the new `visibleStates()` order — existing behavior, now covering group moves |

## Failure Modes

| Component     | Failure Mode                                                    | Trigger                                                               | Impact                                   | Mitigation                                                                                                                            |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Row model     | Rendered order diverges from `visibleStates()` order            | `dashboardRows()` and `visibleStates()` computing order independently | Selection highlights the wrong row       | `dashboardRows()` is _derived from_ `visibleStates()` output, never re-sorts; test asserts flattened agent rows === `visibleStates()` |
| Column sizing | One extreme window name starves the detail column for every row | 60-char window name                                                   | Detail column pinned at floor everywhere | Accepted for MVP (contract: window never truncates before detail/branch give way); last-resort `truncateWidth` still bounds it        |
| Scroll        | Selected row hidden behind header lines                         | Selected agent in a large group near viewport edge                    | Selected row scrolls out of view         | Scroll math uses `selectedRowIndex()` (row-space), tested at viewport boundaries                                                      |
| Statusline    | Chip label changes break click ranges                           | Editing line 26 beyond the bold span                                  | Click-to-switch breaks silently          | Test asserts `#[range=user                                                                                                            | paneId]` markers byte-identical to before |
| Emoji width   | Terminal renders an emoji at 1 cell where `charWidth` says 2    | Terminal/font disagreement (rare)                                     | One-cell misalignment on that row        | Accept — `charWidth` matches tmux's wcwidth behavior; no per-terminal detection                                                       |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test
bun run build   # standalone binary still compiles
```

## Rollout Considerations

- No feature flag — TUI rendering change, ships in the next release tag.
- Rollback plan: revert the single PR; no state/format migrations involved.
- Note for release notes: dashboard layout change (grouped sessions) is the headline; statusline chips now show window names.

## Open Items

None.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
