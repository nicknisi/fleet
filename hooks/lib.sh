#!/usr/bin/env bash
# Fleet hook shared library

FLEET_STATUS_DIR="${HOME}/.cache/claude-status"
mkdir -p "$FLEET_STATUS_DIR"

[ -z "$TMUX" ] && exit 0

FLEET_PANE_ID="${TMUX_PANE}"
[ -z "$FLEET_PANE_ID" ] && exit 0

FLEET_PANE_NUM="${FLEET_PANE_ID#%}"
FLEET_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
[ -z "$FLEET_SESSION" ] && exit 0

FLEET_TS=$(date +%s)
FLEET_TMUX_PID=$(tmux display-message -p '#{pid}' 2>/dev/null)
FLEET_STATUS_FILE="${FLEET_STATUS_DIR}/${FLEET_PANE_NUM}.status"
FLEET_EVENTS_FILE="${FLEET_STATUS_DIR}/${FLEET_PANE_NUM}.events.jsonl"

fleet_write_status() {
  local state="$1" tool="${2:-}"
  printf '{"state":"%s","pane":"%s","session":"%s","tool":"%s","ts":%s,"tmux_pid":%s}\n' \
    "$state" "$FLEET_PANE_ID" "$FLEET_SESSION" "$tool" "$FLEET_TS" "${FLEET_TMUX_PID:-0}" \
    > "$FLEET_STATUS_FILE"
}

fleet_append_event() {
  local event="$1"
  shift
  local extra=""
  while [ $# -gt 0 ]; do
    extra="${extra},\"$1\":$2"
    shift 2
  done
  printf '{"event":"%s","ts":%s%s}\n' "$event" "$FLEET_TS" "$extra" >> "$FLEET_EVENTS_FILE"
}

fleet_notify() {
  local state="$1" session="$2" pane_id="$3" tool="${4:-}"
  case "$state" in
    permit|question|done|waiting|completed) ;;
    *) return ;;
  esac

  local current_pane
  current_pane=$(tmux display-message -p '#{pane_id}' 2>/dev/null)
  [ "$current_pane" = "$pane_id" ] && return

  local current_session
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)

  local icon="⏳"
  [ "$state" = "permit" ] && icon="⚠"
  [ "$state" = "question" ] && icon="?"
  [ "$state" = "done" ] || [ "$state" = "completed" ] && icon="✓"
  local msg="$icon $session"
  [ -n "$tool" ] && msg="$msg ($tool)"

  tmux display-message -d 3000 "$msg" 2>/dev/null

  if [ "$current_session" != "$session" ]; then
    tmux run-shell -t "$pane_id" "printf '\\a'" 2>/dev/null
  fi
}
