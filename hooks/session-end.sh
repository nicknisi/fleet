#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

fleet_append_event "SessionEnd"
rm -f "$FLEET_STATUS_FILE"
rm -f "$FLEET_EVENTS_FILE"

exit 0
