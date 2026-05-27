#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // "end_turn"' 2>/dev/null)
BG_TASKS=$(echo "$INPUT" | jq -r '.background_tasks // false' 2>/dev/null)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

fleet_append_event "Stop" "stop_reason" "\"$STOP_REASON\"" "background_tasks" "$BG_TASKS"

if [ "$STOP_REASON" = "tool_use" ]; then
  fleet_write_status "working" "$TOOL"
  exit 0
fi

if [ "$BG_TASKS" = "true" ]; then
  fleet_write_status "working" "$TOOL"
  exit 0
fi

(
  sleep 3
  if [ -f "$FLEET_STATUS_FILE" ]; then
    CURRENT_TS=$(jq -r '.ts // 0' "$FLEET_STATUS_FILE" 2>/dev/null)
    if [ "$CURRENT_TS" = "$FLEET_TS" ]; then
      fleet_write_status "completed" "$TOOL"
      fleet_notify "completed" "$FLEET_SESSION" "$FLEET_PANE_ID" "$TOOL" >/dev/null 2>&1
    fi
  fi
) &

exit 0
