# Clear / mark-as-read notifications in the tmux status line

Date: 2026-06-08

## Problem

The fleet status line (tmux row 2) lists agents whose turn it is for you to act
on: `PERMIT` (blocked on a permission prompt), `QUESTION` (asking), and `DONE`
(ready / finished, waiting on your next move). Today the only status-line
interaction is a left-click, bound to `fleet switch <paneId>`, which both
acknowledges a ready agent (flips `DONE` → `idle`) **and** switches the tmux
client to that pane.

There is no way to clear a ready notification *without* jumping to its pane, and
no way to clear all of them at once. `fleet ack <pane-id>` already acknowledges
in place without switching, but nothing in tmux is bound to it.

## Scope

- Only **ready (`DONE`)** agents are dismissible. `PERMIT` and `QUESTION`
  represent an agent that is genuinely blocked/waiting; dismissing them would
  hide a live pending action, and they would re-assert on the next refresh
  anyway. `acknowledgedStatus()` already gates on ready-only — we reuse that.
- Two new interactions, both routed through existing CLI commands:
  - **Per-item dismiss** — right-click a ready entry to acknowledge it without
    switching.
  - **Clear-all** — click a dedicated `✕ clear` chip to acknowledge every ready
    agent at once.

## Design

### Sentinel constant

`src/state/types.ts`:

```ts
export const ACK_ALL_RANGE = '__ack_all__';
```

Shared by the renderer (range name) and the CLI router (target detection).

### Renderer — `src/cli/status.ts` `formatStatusLine`

When the filtered (`PERMIT`/`QUESTION`/`DONE`) set contains at least one `DONE`,
append a trailing chip after the existing entries, joined with the same `│`
divider:

```
#[range=user|__ack_all__]#[fg=#6c7086]✕ clear#[norange]
```

No chip is rendered when nothing is ready.

### Acknowledge-all helper — `index.ts`

```ts
function acknowledgeAllReady(statusDirs: string[]): void {
  for (const hook of readAllStatusDirs(statusDirs)) {
    acknowledgePane(hook.pane, statusDirs);
  }
}
```

Reuses the DONE-only gating in `acknowledgedStatus` (called inside
`acknowledgePane`), so `PERMIT`/`QUESTION` are left untouched for free.

### CLI routing — `index.ts`

- **`switch`**: if `target === ACK_ALL_RANGE` → `acknowledgeAllReady` +
  `refresh-client -S`, then return (no switch). Otherwise the current
  ack-then-switch behavior.
- **`ack`**: if `target === ACK_ALL_RANGE` → `acknowledgeAllReady` + redraw.
  Otherwise `acknowledgePane(target)` + `refresh-client -S` (right-click single
  dismiss).
- A small best-effort helper runs `tmux refresh-client -S` so the bar redraws
  immediately instead of waiting for the next status-interval (~15s). The switch
  path already redraws by switching the client.

### tmux bindings — `src/cli/statusline.ts`

- Loosen the existing `MouseDown1Status` guard from `#{m:%*,#{mouse_status_range}}`
  to a non-empty check `#{!=:#{mouse_status_range},}`, so the clear chip's
  sentinel range also routes through `fleet switch`.
- Add a `MouseDown3Status` (right-click) binding with the same guard →
  `fleet ack "#{mouse_status_range}"`.
- `buildRemoveCommands` also unbinds `MouseDown3Status`.

## Behavior summary

| Interaction                  | Result                                  |
| ---------------------------- | --------------------------------------- |
| Left-click a ready entry     | Switch to pane + acknowledge (unchanged)|
| Right-click a ready entry    | Acknowledge in place (no switch)        |
| Click `✕ clear`              | Acknowledge all ready agents            |
| PERMIT / QUESTION entries    | Never dismissible                       |

## Testing

- `status.test.ts`: `✕ clear` chip present iff a `DONE` exists; correct sentinel
  range string; absent when only `PERMIT`/`QUESTION` (or nothing) present.
- `statusline.test.ts`: inject includes both `MouseDown1Status` and
  `MouseDown3Status` with the loosened guard; remove unbinds both.
- Acknowledge: ack-all flips only ready states, leaves `PERMIT`/`QUESTION`
  unchanged.

## Out of scope

- Dismissing `PERMIT`/`QUESTION` notifications.
- Any change to the dashboard TUI click/keyboard behavior.
- Persisting a separate "read" flag — acknowledgement reuses the existing
  `DONE` → `idle` flip; no new state field.
