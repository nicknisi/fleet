# Context Map: session-grouped-dashboard

**Phase**: 1 (single-phase)
**Gates**: 5/5 ready
**Verdict**: GO

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Scope clarity | ready | Every file to change is named in the spec's File Changes table with concrete edits; all pattern/modified files were read and exist (except `src/tui/dashboard.test.ts`, a new file). |
| Pattern familiarity | ready | Read `sessionLabel` (`types.ts:73-76`), `formatSessionRow`/`truncate`/`calculateScroll` (`dashboard.ts:66-145`), and `visibleLength`/`truncateAnsi` (`ansi.ts:34-90`) — the exact patterns the new helpers mirror. |
| Dependency awareness | ready | Blast radius mapped: `visibleStates()` consumed by `dashboard.ts`, `app.ts` internals, and `index.ts:638,752`; `renderSessionList` by `render.ts:68,92`; `sessionLabel` stays exported. One off-spec consumer flagged below (see Risks). |
| Edge case coverage | ready | Concrete edge list assembled from spec + code: empty/equal window, 0 agents, singleton, group-of-N, tied urgency, narrow cols (branch-drop vs window-truncate), header scroll-off, mouse-click row mapping. |
| Test strategy | ready | Inner loop `bun test src/tui`; validation `bun run typecheck && bun run lint && bun test && bun run build`; per-component check commands in spec; test fixture conventions confirmed in `app.test.ts`, `types.test.ts`, `render.test.ts`. |

## Key Patterns

- `src/state/types.ts:73-76` — `sessionLabel(state)`: the exact shape `windowLabel` mirrors (same empty/`window===session` guard, inverse preference). `displayName` at :78-80 wraps it; leave unchanged.
- `src/tui/dashboard.ts:66-96` — `formatSessionRow`: color lookup via `getStateColor`, selection bar `▌`, `.padEnd()` column layout, `fixedW = 3+15+1+14+5`, final `truncateAnsi(row, cols)` clamp. The new `DashboardRow` renderer replaces this; the content-sized name column removes the hardcoded `15`.
- `src/tui/dashboard.ts:133-145` — private `.length`-based `truncate` (to be replaced by `truncateWidth`) and `calculateScroll(selected, viewHeight, total)` (to take `selectedRowIndex()`/`rows.length`).
- `src/terminal/ansi.ts:34-90` — `visibleLength` (cell-counting via `charWidth`, emoji=2) and `truncateAnsi` (ANSI-aware, surrogate-safe). `padAnsi`/`truncateWidth` build on these; `charWidth` (:8-32) already handles `0xfe0f` variation selectors and emoji ranges.

## Dependencies

- `app.ts visibleStates()` — consumed by → `dashboard.ts:47,56,60` (rendering), `app.ts:44,85,144,176` (internal: `updateStates` re-anchor, `selectedState`, `moveDown`, `clampSelection`), `index.ts:638-641`, `index.ts:752-755`. Spec's invariant (flat list in rendered order) keeps all internal consumers working with zero changes.
- `dashboard.ts renderSessionList` — consumed by → `render.ts:68` (preview split), `render.ts:92` (dashboard). Signature unchanged in spec; safe.
- `types.ts sessionLabel` — consumed by → `dashboard.ts:73`, `preview.ts:37`, `kill.ts:26`, `displayName` (:79), tests. Spec replaces the call sites in dashboard/preview/kill with `windowLabel` but keeps `sessionLabel` exported (still used by `displayName` and `/` filter context).
- `cli/status.ts formatStatusLine` — the `#[range=user|${s.paneId}]` markers are the click-identity, independent of the label change; `status.test.ts:140-166` already asserts ranges, so they'll catch a regression.

## Conventions

- **Naming**: camelCase functions; `*.test.ts` collocated next to source; discriminated unions via `kind` literal (spec's `DashboardRow`).
- **Imports**: relative with explicit `.ts` extension; type-only imports use `import { type X }`.
- **Error handling**: try/catch around `capturePane` only (`preview.ts:49`); pure string/array logic elsewhere with no throwing.
- **Types**: `const X = {...} as const` + `type X = (typeof X)[keyof typeof X]` enum pattern (`AgentStatus`, `TuiMode`); strict mode with `noUncheckedIndexedAccess` (note the `!` non-null assertions on array access throughout).
- **Testing**: `bun:test` (`describe`/`test`/`expect`); `makeState`/`base` fixture builders per file; `disableColors()` in render/frame tests; `mock.module` for tmux. New `windowLabel` tests extend the `base` fixture in `types.test.ts:67-94`.

## Risks

- **Off-spec consumer — mouse click row mapping.** `index.ts:636-641` computes `idx = mouse.y - headerHeight - 2` and indexes directly into `visibleStates()`, assuming a 1:1 rendered-line-to-state mapping with no interleaved header lines. Grouped rendering inserts header lines, so a click will select the wrong agent (or a phantom index). This file is **not** in the spec's Modified Files list. The builder must reconcile click-y → row → state through `dashboardRows()`/`selectedRowIndex()` inverse logic, or clicks break silently. Highest-priority gap.
- **Scroll/row-space coupling.** `render.ts` passes `contentRows` as `maxRows` and relies on `renderSessionList` returning ≤ that many lines; with `calculateScroll` moving to row-space, the builder must ensure header lines are counted in the scroll window so `linesWritten` math in `render.ts:88-97` stays correct.
- **`render.test.ts` frame snapshots.** Existing frame assertions assume the flat layout; grouped output changes line positions. Spec lists `render.test.ts` as modified — builder must update, not just add.
- **`dashboard.test.ts` is net-new.** No existing dashboard test file to pattern-match against; mirror `render.test.ts` conventions (`disableColors()`, fixed-width calls).
- **No risk on statusline ranges** — `status.test.ts:140-166` already guards `#[range=user|...]` count and content, so the label change is well-covered.
