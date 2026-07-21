#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"
. "$(dirname "$0")/label.sh"

RAW_TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
LABEL=$(printf '%s' "$INPUT" | fleet_tool_label)
[ -z "$LABEL" ] && LABEL="$RAW_TOOL"          # fall back to the bare tool name

# Event BEFORE status: the reader derives from the last event and prefers it
# over the status file, so appending first means it can never see a new status
# paired with the previous (stale) event.
fleet_append_event "PreToolUse" "tool" "$(printf '%s' "$RAW_TOOL" | jq -Rs .)"  # RAW → event (slurp: empty → "")
fleet_write_status "working" "$LABEL"          # enriched → .status label

exit 0
