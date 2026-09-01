#!/usr/bin/env bash
# Show what iCUE says about HTML widgets.
#
#   ./tools/logs.sh            widget-related lines from the newest log
#   ./tools/logs.sh --follow   ...and keep following as iCUE writes
#   ./tools/logs.sh --all      the whole newest log, unfiltered
#   ./tools/logs.sh --list     available log files, newest first
#
# This is the only feedback channel for a failed install. iCUE logs a
# "Starting validation..." / "is succesfully validated" pair for every widget it finds,
# including sideloaded ones, so a missing pair means iCUE never saw your folder and a
# missing "validated" means the manifest or index.html was rejected.
#
# Note: widget console.log() does NOT appear here. See docs/icue-widget-api.md.
set -uo pipefail

LOG_DIR="${ICUE_LOG_DIR:-/mnt/c/Users/$(basename "$HOME")/AppData/Local/Corsair/Logs/CUE5}"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "error: iCUE log directory not found: $LOG_DIR" >&2
  echo "       set ICUE_LOG_DIR to override." >&2
  exit 1
fi

newest() { ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1; }

# Channels that say something about widgets, plus our widget's own id.
FILTER='cue\.mod\.widgets|cue\.html\.|cue\.widgets\.|html_widget|businessinfocenter|linkprovider|webengine'

case "${1:-}" in
  --list)
    ls -lt "$LOG_DIR"/*.log | head -10
    ;;
  --all)
    log="$(newest)"; echo "== $log" >&2; cat "$log"
    ;;
  --follow)
    log="$(newest)"; echo "== following $log (Ctrl-C to stop)" >&2
    tail -n 50 -f "$log" | grep --line-buffered -iE "$FILTER"
    ;;
  "")
    log="$(newest)"
    if [[ -z "$log" ]]; then echo "no log files in $LOG_DIR" >&2; exit 1; fi
    echo "== $log" >&2
    grep -iE "$FILTER" "$log" || echo "(no widget lines in this log)"
    ;;
  *)
    echo "usage: $0 [--follow|--all|--list]" >&2; exit 2
    ;;
esac
