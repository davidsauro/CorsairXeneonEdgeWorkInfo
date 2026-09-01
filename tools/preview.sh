#!/usr/bin/env bash
# Serve the widget for browser-based development and print a ready-made preview URL.
#
# Outside iCUE the property globals and tr() do not exist, so js/icue-bridge.js falls back
# to each property's declared data-default and lets ?name=value in the URL stand in for the
# settings panel. That makes the whole widget inspectable in Chrome devtools.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8123}"
ZONE="${TZ_OVERRIDE:-$(timedatectl show --property=Timezone --value 2>/dev/null || echo America/New_York)}"

# serve.py listens on both stacks, so "localhost" works from a browser on Windows even
# when the server runs in WSL. Prefer it over the WSL IP: http://localhost is a secure
# context, so navigator.clipboard works and the widget's COPY button is testable, matching
# the file:// origin iCUE uses. http://<ip> is not a secure context and COPY will fail.
HOST="localhost"

BASE="http://$HOST:$PORT/src/index.html"
FIXTURE="http://$HOST:$PORT/test/fixtures/busy.ics"

cat <<EOF
Serving $REPO_ROOT on port $PORT

  Empty state:
    $BASE

  With the bundled busy-calendar fixture and live weather:
    $BASE?calendarUrl1=$FIXTURE&weatherQuery=Boston&timeZone=$ZONE&timeFormat=12h&agendaDays=3

  With your real Google calendar through the local proxy:
    $BASE?calendarUrl1=<paste-secret-ics-url>&proxyBase=http://localhost:8010&weatherQuery=Boston&timeZone=$ZONE

Size the window to 2536x696 to match the XENEON EDGE extra-wide slot.
Use the localhost URLs, not the LAN IP: only localhost is a secure context, and the
invite panel's COPY button needs one. Ctrl-C to stop.
EOF

exec python3 "$REPO_ROOT/tools/serve.py" "$PORT" "$REPO_ROOT"
