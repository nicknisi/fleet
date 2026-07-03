#!/usr/bin/env bash
# Pure: reads a PreToolUse JSON payload on stdin, prints an enriched activity
# label on stdout. No tmux, no filesystem — sourceable for unit checks.
fleet_tool_label() {
  jq -r '
    .tool_name as $t | (.tool_input // {}) as $in
    | if $t == "Bash" then
        "Bash: " + (($in.command // "") | gsub("\\s+"; " ") | .[0:48])
      elif ($t == "Edit" or $t == "Write" or $t == "Read" or $t == "NotebookEdit") then
        $t + ": " + (($in.file_path // $in.notebook_path // "") | split("/") | (last // ""))
      else
        ($t // "")
      end
  ' 2>/dev/null
}
