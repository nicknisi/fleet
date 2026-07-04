#!/usr/bin/env bash
# Fleet Codex hook — one parameterized script for both events Codex fires:
#   codex-hook.sh PreToolUse   (a tool is about to run -> working)
#   codex-hook.sh Stop         (turn ended -> working if more work, else done)
# Codex has no $CLAUDE_PLUGIN_ROOT, so `fleet install codex` writes this script's
# absolute path into ~/.codex/hooks.json. It reuses hooks/lib.sh by pointing
# FLEET_STATUS_DIR at Codex's own status dir BEFORE sourcing (lib.sh honors the
# override); the [ -z "$TMUX" ] guard and TMUX_PANE capture in lib.sh are
# agent-agnostic — Codex runs inside the tmux pane exactly like Claude.
INPUT=$(cat)
EVENT="${1:-}"
# Default to Codex's status dir, but honor a caller-set FLEET_STATUS_DIR (same
# ${VAR:-default} pattern lib.sh uses) so the hook is testable against a temp dir.
export FLEET_STATUS_DIR="${FLEET_STATUS_DIR:-${HOME}/.cache/codex-status}"
. "$(dirname "$0")/../lib.sh" # ../ -> hooks/lib.sh; sets FLEET_STATUS_FILE etc.

case "$EVENT" in
  PreToolUse)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
    fleet_write_status "working" "$TOOL"
    fleet_append_event "PreToolUse" "tool" "\"$TOOL\""
    ;;
  Stop)
    STOP_REASON=$(printf '%s' "$INPUT" | jq -r '.stop_reason // "end_turn"' 2>/dev/null)
    BG_TASKS=$(printf '%s' "$INPUT" | jq -r '.background_tasks // false' 2>/dev/null)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
    fleet_append_event "Stop" "stop_reason" "\"$STOP_REASON\"" "background_tasks" "$BG_TASKS"
    if [ "$STOP_REASON" = "tool_use" ] || [ "$BG_TASKS" = "true" ]; then
      fleet_write_status "working" "$TOOL"
    else
      # Debounced done: a new turn within 3s rewrites .status with a fresh ts, so
      # the ts-equality check cancels this stale done (same guard as stop.sh).
      (
        sleep 3
        if [ -f "$FLEET_STATUS_FILE" ]; then
          CURRENT_TS=$(jq -r '.ts // 0' "$FLEET_STATUS_FILE" 2>/dev/null)
          if [ "$CURRENT_TS" = "$FLEET_TS" ]; then
            fleet_write_status "done" "$TOOL"
            fleet_notify "done" "$FLEET_SESSION" "$FLEET_PANE_ID" "$TOOL" >/dev/null 2>&1
          fi
        fi
      ) &
    fi
    ;;
esac
exit 0
