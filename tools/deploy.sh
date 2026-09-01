#!/usr/bin/env bash
# Install (or reinstall) this widget into iCUE 5 so it appears in the widget picker.
#
#   ./tools/deploy.sh            install / update
#   ./tools/deploy.sh --remove   uninstall
#
# iCUE reads widgets from %APPDATA%\Corsair\CUE5\html_widgets\<folder>\. The folder name
# is arbitrary; iCUE uses a GUID when it imports one, so we generate one on first run and
# keep it in .widget-id to stay on the same install across deploys.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/src"
ID_FILE="$REPO_ROOT/.widget-id"

WIDGETS_DIR="${ICUE_WIDGETS_DIR:-/mnt/c/Users/$(basename "$HOME")/AppData/Roaming/Corsair/CUE5/html_widgets}"

if [[ ! -d "$WIDGETS_DIR" ]]; then
  echo "error: iCUE widget directory not found: $WIDGETS_DIR" >&2
  echo "       set ICUE_WIDGETS_DIR to override." >&2
  exit 1
fi

if [[ ! -f "$ID_FILE" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z' > "$ID_FILE"
  else
    python3 -c "import uuid;print(uuid.uuid4())" > "$ID_FILE"
  fi
  echo "generated widget install id: $(cat "$ID_FILE")"
fi

WIDGET_ID="$(tr -d '[:space:]' < "$ID_FILE")"
TARGET="$WIDGETS_DIR/$WIDGET_ID"

if [[ "${1:-}" == "--remove" ]]; then
  rm -rf "$TARGET"
  echo "removed $TARGET"
  echo "restart iCUE to pick up the change."
  exit 0
fi

# Fail early on malformed JSON rather than letting iCUE silently skip the widget.
python3 - "$SRC" <<'PY'
import json, sys, pathlib
src = pathlib.Path(sys.argv[1])
for name in ("manifest.json", "translation.json"):
    path = src / name
    if path.exists():
        json.loads(path.read_text(encoding="utf-8"))
manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
for key in ("id", "name", "version", "preview_icon", "supported_devices"):
    if key not in manifest:
        raise SystemExit(f"manifest.json is missing required key: {key}")
icon = src / manifest["preview_icon"]
if not icon.exists():
    raise SystemExit(f"preview_icon does not exist: {icon}")
print(f"manifest ok: {manifest['name']} {manifest['version']} ({manifest['id']})")
PY

rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$SRC"/. "$TARGET"/

echo "installed to $TARGET"

# The calendar half of the widget is useless without the proxy, so say so up front.
if curl -s -m 2 -o /dev/null "http://localhost:8010/health"; then
  echo "proxy: reachable on http://localhost:8010"
else
  echo "proxy: NOT reachable on http://localhost:8010 — start it with"
  echo "       (cd /home/daves/localproxy && node proxy.js)"
  echo "       Google Calendar feeds will show OFFLINE until it is running."
fi

echo
echo "next: fully quit iCUE (tray icon -> Quit) and relaunch it, then add the widget"
echo "      from the XENEON EDGE dashboard editor."
