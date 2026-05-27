#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")

fleet_write_status "working" "$TOOL"
fleet_append_event "PreToolUse" "tool" "\"$TOOL\""

exit 0
