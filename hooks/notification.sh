#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

# Claude Code sends the notification kind in `notification_type`. Documented values:
#   permission_prompt    — tool approval OR AskUserQuestion. The hook can't tell
#                          these apart; the scraper refines permit -> question by
#                          reading the on-screen dialog ([y/n] vs "Enter to select").
#   idle_prompt          — waiting for input long enough to nag the user.
#   elicitation_dialog   — an MCP server is asking the user for input mid-tool-call.
#   elicitation_complete / elicitation_response — that elicitation resolved.
#   auth_success         — auth confirmation; not actionable.
NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // empty' 2>/dev/null)

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
