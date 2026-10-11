#!/bin/sh
# Complementer statusLine passthrough. $1 = extension storage dir.
# Saves the JSON Claude Code sends on stdin for the extension, then runs the user's original
# statusLine command with the same stdin, so their status line is unchanged.
d="$1"
live="$d/live"
[ -d "$live" ] || mkdir -p "$live" 2>/dev/null
json=$(cat)

orig=""
[ -f "$d/original-command" ] && orig=$(cat "$d/original-command")
[ -n "$orig" ] && printf '%s\n' "$json" | eval "$orig"

# Extract session_id with shell builtins only (no extra processes on the hot path).
case "$json" in
  *'"session_id":"'*) rest=${json#*'"session_id":"'} ;;
  *'"session_id": "'*) rest=${json#*'"session_id": "'} ;;
  *) rest="" ;;
esac
sid=${rest%%\"*}
case "$sid" in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac

tmp="$live/.in.$$"
printf '%s' "$json" > "$tmp" 2>/dev/null && mv -f "$tmp" "$live/$sid.json" 2>/dev/null
exit 0
