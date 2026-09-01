# iCUE 5 HTML Widget API

Reverse-engineered from the 19 first-party widgets that ship inside
`C:\Program Files\Corsair\CORSAIR iCUE5 Software\widgets\` and from strings in
`HtmlWidgetCore.dll`. Corsair publishes no formal SDK docs, so those widgets are the
reference implementation — read them when something here is unclear.

## Anatomy of a widget

A widget is a folder of plain static files. No build step, no bundler, no package manager.

```
<widget-folder>/
  manifest.json      required — identity + capabilities
  index.html         required — entry point; properties are declared in <head>
  translation.json   optional — key -> string, per language
  resources/         icons, preview images, svg
  styles/            css
  js/                js
```

Installed widgets live in:

```
%APPDATA%\Corsair\CUE5\html_widgets\<folder>\
```

The folder name is arbitrary. iCUE names it with a GUID when importing, but a
hand-created folder is picked up the same way after an iCUE restart.

## manifest.json

```json
{
  "author": "Your Name",
  "id": "com.you.widgetname",
  "name": "Widget Name",
  "description": "Shown in the widget picker.",
  "version": "1.0.0",
  "preview_icon": "resources/icon.svg",
  "min_framework_version": "1.0.0",
  "min_app_version": "5.47",
  "os": [{ "platform": "windows" }, { "platform": "mac" }],
  "supported_devices": [{ "type": "dashboard_lcd" }],
  "interactive": true,
  "required_plugins": ["widgetbuilder.sensorsdataprovider:Sensors:1.0"],
  "modules": ["modules/Something.mjs"]
}
```

| Key | Notes |
| --- | --- |
| `id` | Reverse-DNS. Must be unique across installed widgets. |
| `preview_icon` | Path relative to the widget folder. Must exist or the widget is skipped. |
| `min_framework_version` | Widget-host version. First-party widgets use `1.0.0`–`1.3.0`. |
| `supported_devices[].type` | `dashboard_lcd` (XENEON EDGE), `keyboard_lcd`, `pump_lcd`. |
| `supported_devices[].features` | Seen only as `["sensor-screen"]`. |
| `interactive` | `true` enables touch input. Without it, taps do nothing. |
| `required_plugins` | `"<qml-module>:<Name>:<version>"`. Exposes `window.plugins.<Name>`. |
| `modules` | ES modules whose exports can be named in `data-values` / `data-default`. See below. |

Available plugin modules (`cueuiqmlplugins/widgetbuilder/`):
`sensorsdataprovider`, `mediadataprovider`, `fpsdataprovider`, `notificationsprovider`,
`streamdeck`, `deviceactionprovider`, `linkprovider`.

### Opening a URL on the host PC

`linkprovider` is the escape hatch out of the widget sandbox, and no shipped widget uses
it, so it is easy to miss. Its whole implementation is:

```qml
// cueuiqmlplugins/widgetbuilder/linkprovider/qml/Url.qml
QtObject {
    id: root
    function open(link) {
        Qt.openUrlExternally(link);
    }
}
```

`Qt.openUrlExternally` hands the URL to the OS, so an `https://` link opens in the default
browser and a registered scheme (`zoommtg:`, `msteams:`) opens that client. Declare it and
call it:

```json
"required_plugins": ["widgetbuilder.linkprovider:Url:1.0"]
```
```js
window.plugins.Linkprovider.open("https://meet.google.com/abc-defg-hij");
```

**The object's name is derived from the module, not the alias.** The Sensor widget declares
`widgetbuilder.sensorsdataprovider:Sensors:1.0` and reads
`window.plugins.Sensorsdataprovider` — the last module segment, capitalised. Since that
mapping is inferred from a single example, probe the plausible spellings and check for the
method rather than betting on one name.

`open()` returns nothing, so it needs none of the requestId/`asyncResponse` ceremony that
the value-returning plugins use — call it directly.

Nothing reports back whether the URL actually opened, so always leave a fallback on screen:
show the URL as selectable text and offer a clipboard copy.

## Declaring settings (properties)

Each property becomes a control in the widget's settings panel and is injected into the
page as a **bare global variable of the same name**.

```html
<meta name="x-icue-property" content="accentColor"
      data-label="tr('Accent Color')" data-type="color" data-default="'#00C2FF'" />
```

`data-*` values are **expressions evaluated by iCUE**, not literal strings. A string
default therefore needs inner quotes: `data-default="'#FFFFFF'"`.

### Property types

| `data-type` | Extra attributes | Value in JS |
| --- | --- | --- |
| `textfield` | `data-placeholder` | string |
| `switch` | | boolean |
| `slider` | `data-min`, `data-max`, `data-step`, `data-unit-label` | number |
| `color` | | `"#RRGGBB"` |
| `colors` | | list of colors |
| `combobox` | `data-values` | selected `key` |
| `search-combobox` | `data-values` | selected `key` |
| `tab-buttons` | `data-values` | selected `key` |
| `slider-enum` | `data-values` | selected `key` |
| `media-selector` | `data-filters` | object: `pathToAsset`, `baseWidth`, `baseHeight`, `scale`, `positionX`, `positionY`, `angle` |
| `sensors-combobox` | | sensor id string |
| `time-format` | | `"12h"` / `"24h"` |
| `accounts-list`, `app-status` | | first-party integrations |

### Async values from a module

`data-values` and `data-default` can name an exported function instead of a literal list,
which is how the shipped Weather widget populates its location search:

```json
"modules": ["modules/OpenMeteo.mjs"]
```
```html
<meta name="x-icue-property" content="weatherLocation"
      data-type="search-combobox"
      data-values="OpenMeteo.getWeatherLocations"
      data-default="OpenMeteo.getDefaultLocation" />
```

The functions may return promises, and the settings panel awaits them. Note that the
module is evaluated by the *settings panel*, not the widget page — Weather's own
`<script src="modules/OpenMeteo.mjs">` tag has no `type="module"`, so its `export`
statements would throw if the page really ran it. Treat the module as settings-panel-only
and keep the widget's runtime code in ordinary scripts.

There is also an undocumented `iCUE.ipRegistryApiKey`, used by Weather to IP-geolocate a
default city via `api.ipregistry.co`. Do not rely on it: prefer asking the user for a
location, or geocode a name they type.

`data-values` takes a list of `{'key': ..., 'value': ...}` pairs — `key` is what your JS
reads, `value` is the label shown to the user:

```html
data-values="[{'key':'12h','value':tr('12h')},{'key':'24h','value':tr('24h')}]"
```

### Grouping and previews

```html
<script type="application/json" id="x-icue-groups">
[
  { "title": "tr('Clock')", "properties": ["timeFormat", "seconds"],
    "info": "tr('Optional helper text under the group.')" }
]
</script>

<meta name="x-icue-widget-group" content="tr('Clock Face')">
<meta name="x-icue-widget-preview" content="resources/Preview.png">
```

`x-icue-widget-group` puts several widgets under one picker entry (how the three
AnalogClock widgets appear as one "Clock Face" item with style variants).

## Runtime globals

| Global | Description |
| --- | --- |
| `<propertyName>` | Current value of each declared property. |
| `iCUE_initialized` | `true` once the host has injected everything. |
| `iCUE.iCUELanguage` | `"en"`, `"de"`, `"es"`, `"fr"`, … |
| `iCUE.allTimeZones()` | Time-zone list, for `data-values` in the settings panel. |
| `iCUE.defaultTimeZone()` | IANA zone, sometimes suffixed `" (UTC+x)"` — split on space. |
| `iCUE.default24HourFormat()` | `"12h"` or `"24h"` from OS locale. |
| `iCUE.defaultTemperatureUnit()` | OS locale default. Return format unverified — no shipped widget uses it. |
| `iCUE.defaultSpeedUnit()` | As above. |
| `iCUE.formatUserLocaleDate()` / `formatUserLocaleTime()` | Host-side locale formatting. |
| `iCUE.isPreview` | `true` in the settings-panel preview, `false` on the device. Useful for skipping network calls while the user is editing. |
| `iCUE.fpsLimit` | Frame cap the host wants the widget to respect. |
| `uniqueId` | Stable id for this *placed instance*. Namespace `localStorage` with it. |
| `tr(key)` | Returns a **Promise\<string\>** resolved against `translation.json`. |
| `window.plugins.<Name>` | Qt WebChannel objects from `required_plugins`. |

## Lifecycle

Assign a global `icueEvents` object, then handle the race where the host may already be
initialized before your script runs:

```js
icueEvents = {
  onICUEInitialized: onReady,   // fires once, after properties are injected
  onDataUpdated: onUpdate       // fires on every settings change
};

if (iCUE_initialized) onReady();
```

`onDataUpdated` gives you no diff — snapshot the properties yourself and compare, so an
unrelated colour tweak doesn't trigger a network refetch.

## Two gotchas that will cost you an afternoon

1. **Property globals may be lexically scoped.** Depending on host version they are
   injected as `let`/`const`, so `globalThis[name]` is `undefined` even though `name`
   resolves fine. Re-expose them with an accessor built from
   `new Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined;")`.

2. **Every element `id` becomes a `window` global.** A property named the same as an
   element id reads back as a DOM `Node`. Guard with `value instanceof Node`.

Both are handled in [`src/js/icue-bridge.js`](../src/js/icue-bridge.js).

## Sensor / media / FPS plugins

Qt WebChannel cannot serialize callbacks, so the plugins use a request-id pattern: you
call `plugin.method(requestId, ...args)` and the answer arrives on the
`plugin.asyncResponse(requestId, value)` signal. Corsair's `IcueWidgetApiWrapper` turns
that into promises.

```js
const api = new SimpleSensorApiWrapper(window.plugins.Sensorsdataprovider);
api.getSensorValue(sensorId).then(v => console.log(v));
```

Available methods: `getSensorValue`, `getSensorUnits`, `getSensorName`,
`getSensorDeviceName`, `getSensorType`, `getSensorKind`, `getAllSensorIds`,
`sensorIsConnected`. Signals: `sensorDataChanged`, `sensorValueChanged`,
`sensorUnitsChanged`, `sensorAdded`, `sensorRemoved`. There is also a per-plugin
`plugin<Name>_initialized` global and a `plugin<Name>Events` callback object.

**Copy these helpers into your own widget.** First-party widgets reference
`../common/plugins/...`, which resolves inside the install directory. A widget in
`html_widgets/` cannot reach it. The same applies to `common/tools/DateFormatter.js`,
`ticker-tracker.js`, and `media_viewer/MediaViewer.js`.

## Layout on the XENEON EDGE

The Edge dashboard places widgets into fixed slots. Sizes observed in the wild:

| Slot | Pixels |
| --- | --- |
| small horizontal | 840 × 344 |
| small vertical | 696 × 416 |
| medium horizontal | 840 × 696 |
| medium vertical | 696 × 840 |
| large horizontal | 1688 × 696 |
| large vertical | 696 × 1688 |
| extra-wide | 2536 × 696 |

First-party widgets target these with narrow `@media (min-aspect-ratio: …)` bands. That is
brittle — classify by width/orientation in JS and set an attribute on `<body>` instead.

Rules that matter:

- Never scroll. `html, body { overflow: hidden }` and make the layout fit.
- Size with `vw`/`vh`/`clamp()`, not fixed pixels.
- Touch targets ≥ 48 × 48 CSS px, and `touch-action: manipulation`.
### Fonts

Corsair's own widgets load typefaces from Qt's internal resource scheme:

```css
src: url("qrc:/fonts/OpenSans-Regular.ttf");
```

Available there: `OpenSans-{Regular,SemiBold,Bold}.ttf`, `Saira-{Light,Regular,Medium,SemiBold}.ttf`,
`Bebas-Neue-Pro-Regular.otf`, `BebasNeuePro-SemiExpBold.ttf`, `DIN-Condensed-Regular.otf`.

**Prefer bundling your own font instead.** Two reasons:

1. `qrc:` does not exist in a plain browser, so preview logs a font load failure (Chrome
   words it like a CORS block) and silently falls back — meaning what you see while
   developing is not what the device renders.
2. Widget pages are loaded via `QUrl::fromLocalFile`, i.e. a `file://` origin. Whether
   Chromium lets a `file://` page read another local scheme is undocumented, and the one
   third-party widget on this machine avoided `qrc:` in favour of `Inter, "Segoe UI"` —
   which suggests it may not work when sideloaded.

A bundled woff2 with a relative path works in both places and removes the question. Note
that Google Fonts serves Open Sans as a *variable* font: one file covers every weight, so
several `@font-face` rules can point at the same file and pin `font-weight` to a single
value each.

Always give every stack a real fallback (`"Segoe UI", Arial, sans-serif`).

## Networking

`fetch()` works, but the page's origin is `file://`-like, so **any server that does not
send permissive CORS headers will fail**. Options, in order of preference:

1. Use an endpoint you control and set `Access-Control-Allow-Origin: *`.
   Open-Meteo already does this, which is why the shipped Weather widget calls it directly.
2. Run a small localhost service that proxies the upstream call. This is what this repo
   does for Google Calendar, and what the third-party Calendar Panel widget does
   (`http://127.0.0.1:38765/v1/ics?url=…`) — it ships a companion app.
3. Have the user paste the data into a `textfield` property.

A localhost proxy also needs to answer Chrome's Private Network Access preflight, so send
`Access-Control-Allow-Private-Network: true` alongside the usual CORS headers.

**If the proxy runs in WSL and iCUE on Windows**, reach it as `http://localhost:<port>` —
Windows resolves that to the IPv6 loopback, which WSL forwards. Literal `127.0.0.1` does
*not* work, and a server bound with `--bind 0.0.0.0` (IPv4 only) will not be reachable from
Windows at all. Bind the IPv6 wildcard, as node's default `listen(port)` does.

Surface failures on screen. A widget that silently shows stale numbers is worse than one
that says `OFFLINE`.

## Page personalization

The XENEON EDGE dashboard has a **Pages personalization** panel with device background,
widget text colour, widget accent colour, widget background colour and widget transparency.
Those reach a widget by **overriding properties with specific well-known names**. There is
no opt-in flag; declare the name and you receive the value.

`WidgetPersonalizationPanelModel` in `modules/DashlcdUI.dll` exposes exactly:

```
customStyleEnabled
textColorSupported     textColor
accentColorSupported   accentColor
accentColor2Supported  accentColor2
                       backgroundColor
                       transparency
```

and `HtmlWidgetCore.dll` carries the same list next to
`widgetPersonalizationCustomStyleEnabled` / `widgetPersonalizationCustomStylePresent`.

| Panel control | Widget property to declare |
| --- | --- |
| Widget text colour | `textColor` |
| Widget accent colour | `accentColor` |
| (second accent, where offered) | `accentColor2` |
| Widget background colour | `backgroundColor` |
| Widget transparency | `transparency` |
| Widget background image/video | `backgroundMedia` |

A property you do not declare simply cannot be driven — that control will appear to do
nothing. Every shipped widget declares the whole set and groups them under a title ending
in "Personalization" (`Widget Personalization`, `Clock Personalization`,
`Sensor Personalization`); worth copying, since it is the only structural convention they
all share.

`transparency` is an **opacity** percentage despite the name: Corsair's widgets compute
`opacity = value / 100` and ship a default of `80`. Apply it to the widget's own background
layer, not to `body`, or the text fades with it.

### Colours do not arrive as CSS

This is the part that silently breaks. iCUE serialises colours the way Qt writes `QColor`:

```xml
<textColor>rgb(1 1 1)</textColor>                      <!-- white -->
<accentColor>rgb(0.941176 0.556863 0.2)</accentColor>  <!-- orange -->
<accentColor>hsv(0.681694 0.754467 0.941176)</accentColor>
```

Normalised 0..1 floats, and sometimes `hsv()`. Assigned straight into CSS:

- `rgb(1 1 1)` is read as 0-255, giving near-black instead of white.
- `hsv(…)` is not a CSS function, so the declaration is dropped entirely.

Normalise before use. Since a component above 1 can only be the 0-255 form, the two are
distinguishable. `src/js/color.js` in this repo does it, with tests.

8-digit hex stays ambiguous: CSS reads `#RRGGBBAA`, Qt writes `#AARRGGBB`, and nothing in
the string distinguishes them — pass it through rather than guessing.

## Clipboard and secure context

`navigator.clipboard.writeText` needs a secure context. Widget pages are loaded via
`QUrl::fromLocalFile`, giving them a `file://` origin, and Chromium treats `file://` as
potentially trustworthy — so the async clipboard API *is* available on the device:

| Origin | `isSecureContext` | `navigator.clipboard` |
| --- | --- | --- |
| `file://` (iCUE) | `true` | available |
| `http://localhost:PORT` | `true` | available |
| `http://192.168.x.x:PORT` | `false` | **undefined** |

The last row is the trap: a dev server reachable only by LAN IP silently has no clipboard,
so a copy button appears broken in preview while working fine once deployed. Serve preview
over `localhost`.

The async API can also sit pending indefinitely when the window is not focused, so race it
against a timeout and fall back to `document.execCommand("copy")`. A copy button that
reports nothing is worse than one that reports failure.

## Storage

`localStorage` persists per widget, under
`%APPDATA%\Corsair\CUE5\html_widgets_browser_storage\`. Always namespace keys with
`uniqueId` so two placements of the same widget don't overwrite each other. Never put
secrets there — treat it as plaintext on disk.

## Debugging

There is no devtools panel. What works:

- **Browser-first development.** Serve the widget and open it in Chrome. Properties are
  `undefined` and `tr()` is missing, so a bridge that falls back to the declared
  `data-default` values lets the whole UI render and be inspected normally. This repo's
  bridge also maps `?name=value` query parameters onto properties, standing in for the
  settings panel — see `tools/preview.sh`. Resize the window to the slot sizes above.
- **Headless screenshots.** Windows Chrome can render the page at an exact slot size,
  which is the fastest way to check a layout:
  `chrome.exe --headless=new --window-size=2536,696 --screenshot=out.png <url>`
- **`console.log` does not reach the iCUE log.** Verified by grepping every log in
  `%LOCALAPPDATA%\Corsair\Logs\CUE5\`: not one line of JS console output appears. Do not
  plan a debugging strategy around it.
- **The iCUE log does tell you whether your widget was accepted.** Every widget it finds,
  sideloaded ones included, produces a pair on the `cue.mod.widgets.html_cache` channel:

  ```
  I cue.mod.widgets.html_cache: Found widget file: ".../html_widgets/<guid>/index.html" Starting validation...
  I cue.mod.widgets.html_cache: Widget file ".../html_widgets/<guid>/index.html" is succesfully validated
  ```

  No pair at all means iCUE never saw your folder. A "Starting validation" with no
  "validated" means the manifest or the HTML was rejected. Translation problems surface
  separately on `cue.html.translation`.
- **Remote DevTools appear to be available.** `iCUE.exe` contains a
  `cue.widgets.webengine_debug` logging category alongside these strings:

  ```
  QtWebEngine remote debugging enabled on port:
  Open in browser: http://localhost:
  Failed to find available port for QtWebEngine remote debugging. All ports are busy.
  ```

  It also references `QTWEBENGINE_REMOTE_DEBUGGING` and `QT_LOGGING_RULES`. So iCUE has a
  built-in hook that exposes a real Chrome DevTools endpoint against the live widget. The
  exact trigger is not confirmed; the two candidates are enabling that logging category
  (`QT_LOGGING_RULES=cue.widgets.webengine_debug.debug=true`) or setting
  `QTWEBENGINE_REMOTE_DEBUGGING` yourself before launching iCUE. Either way the log prints
  the port it chose. This is worth ten minutes to get working before debugging anything
  hard on-device.
- Render error states into the DOM. Assume it is your only feedback channel until the
  above is working.
- iCUE caches widgets aggressively: fully quit from the tray icon and relaunch after
  changing files. Reinstalling into a fresh folder GUID forces a clean read.
