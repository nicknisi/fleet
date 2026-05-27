#!/usr/bin/env bash
INPUT=$(cat)
. "$(dirname "$0")/lib.sh"

fleet_append_event "SubagentStop"

exit 0
