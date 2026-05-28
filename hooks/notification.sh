#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.type // empty' 2>/dev/null)

case "$NOTIFICATION_TYPE" in
  permission_prompt)
    fleet_write_status "permit"
    fleet_append_event "Notification" "notification_type" "\"permission_prompt\""
    fleet_notify "permit" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  elicitation_dialog)
    fleet_write_status "question"
    fleet_append_event "Notification" "notification_type" "\"elicitation_dialog\""
    fleet_notify "question" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  idle_prompt)
    fleet_write_status "done"
    fleet_append_event "Notification" "notification_type" "\"idle_prompt\""
    fleet_notify "done" "$FLEET_SESSION" "$FLEET_PANE_ID" >/dev/null 2>&1 &
    ;;
  *)
    fleet_append_event "Notification" "notification_type" "\"${NOTIFICATION_TYPE:-unknown}\""
    ;;
esac

exit 0
