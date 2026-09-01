/*
 * Business Info Center — clock + weather rail beside a Google-Calendar-style agenda.
 * Sized for the XENEON EDGE 2536x696 slot: left third is the rail, right two thirds
 * are day columns of events with a red now-line in today's column.
 */
(function () {
  "use strict";

  var DAY_MS = 86400000;
  var CALENDAR_COLORS = ["#4285F4", "#0B8043", "#8E24AA"];  // Google's blue / green / purple
  var ROW_HEIGHT_FALLBACK = 46;

  var state = {
    events: [],
    calendarNames: [],
    updatedAt: 0,
    status: "unconfigured",  // unconfigured | live | stale | error
    message: "",
    weather: null,
    weatherError: "",
    resolvedLocation: null,
    selected: null
  };

  var timers = { clock: null, refresh: null, minute: null };

  /* ------------------------------------------------------------------ helpers */

  function el(id) { return document.getElementById(id); }

  function setText(id, value) {
    var node = el(id);
    if (node) node.textContent = value == null ? "" : String(value);
  }

  /**
   * Fill an element from a translation key. The key doubles as the placeholder so the
   * element is never briefly empty — inside iCUE tr() is an async round-trip.
   */
  function setTranslated(node, key) {
    if (!node) return;
    node.textContent = key;
    ICUE.translate(key).then(function (text) { node.textContent = text; });
  }

  function displayZone() {
    var raw = ICUE.string("timeZone", "");
    var zone = raw.split(" ")[0];
    if (zone && ICS.validZone(zone)) return zone;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
    catch (error) { return "UTC"; }
  }

  function use24Hour() { return ICUE.string("timeFormat", "24h") === "24h"; }

  function dayKeyOf(ms, zone) {
    var parts = ICS.partsInZone(ms, zone);
    return parts.y * 10000 + parts.m * 100 + parts.d;
  }

  /** Midnight-anchored day descriptors for the agenda columns. */
  function buildDays(count, zone) {
    var now = Date.now();
    var today = ICS.partsInZone(now, zone);
    var days = [];
    for (var i = 0; i < count; i++) {
      var startMs = ICS.wallToMs({ y: today.y, m: today.m, d: today.d }, zone) + i * DAY_MS;
      var parts = ICS.partsInZone(startMs + 3600000 * 6, zone);  // midday, DST-safe
      days.push({
        index: i,
        key: parts.y * 10000 + parts.m * 100 + parts.d,
        startMs: ICS.wallToMs({ y: parts.y, m: parts.m, d: parts.d }, zone),
        endMs: ICS.wallToMs({ y: parts.y, m: parts.m, d: parts.d }, zone) + DAY_MS,
        isToday: i === 0
      });
    }
    return days;
  }

  var formatterCache = {};
  function formatter(options) {
    var key = JSON.stringify(options);
    if (!formatterCache[key]) formatterCache[key] = new Intl.DateTimeFormat(ICUE.language, options);
    return formatterCache[key];
  }

  function pick(parts, type) {
    var found = parts.find(function (p) { return p.type === type; });
    return found ? found.value : "";
  }

  function formatTime(ms, zone) {
    var parts = formatter({
      timeZone: zone, hour: "numeric", minute: "2-digit",
      hourCycle: use24Hour() ? "h23" : "h12"
    }).formatToParts(new Date(ms));
    var time = pick(parts, "hour") + ":" + pick(parts, "minute");
    var meridiem = pick(parts, "dayPeriod");
    return use24Hour() || !meridiem ? time : time + " " + meridiem.toUpperCase();
  }

  /* ------------------------------------------------------------- appearance */

  function applyAppearance() {
    var root = document.documentElement.style;
    root.setProperty("--text", ICUE.string("textColor", "#F1F3F4"));
    root.setProperty("--accent", ICUE.string("accentColor", "#8AB4F8"));
    root.setProperty("--bg", ICUE.string("backgroundColor", "#0B0D10"));
  }

  /* ------------------------------------------------------------------- clock */

  function tickClock() {
    var zone = displayZone();
    var now = new Date();

    var timeParts = formatter({
      timeZone: zone, hour: "numeric", minute: "2-digit",
      hourCycle: use24Hour() ? "h23" : "h12"
    }).formatToParts(now);

    setText("clockValue", pick(timeParts, "hour") + ":" + pick(timeParts, "minute"));
    setText("clockMeridiem", use24Hour() ? "" : pick(timeParts, "dayPeriod").toUpperCase());

    // Weekday on one line, the date on the next. The second line keeps the locale's own
    // field order and drops the comma Intl would put in.
    var dateParts = formatter({
      timeZone: zone, weekday: "long", month: "long", day: "numeric"
    }).formatToParts(now);
    setText("clockWeekday", pick(dateParts, "weekday"));
    setText("clockMonthDay", dateParts
      .filter(function (p) { return p.type !== "literal" && p.type !== "weekday"; })
      .map(function (p) { return p.value; })
      .join(" "));

    clearTimeout(timers.clock);
    timers.clock = setTimeout(tickClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
  }

  /* --------------------------------------------------------------- calendars */

  function calendarUrls() {
    var proxyBase = ICUE.string("proxyBase", "");
    var seen = {};
    var out = [];
    ["calendarUrl1", "calendarUrl2", "calendarUrl3"].forEach(function (name, index) {
      var url = FeedUrl.forProxy(ICUE.string(name, ""), proxyBase);
      if (!url || seen[url]) return;
      seen[url] = true;
      out.push({ url: url, sourceIndex: index });
    });
    return out;
  }

  function fetchText(url) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; resolve({ text: null, error: "timed out after 20s" }); }
      }, 20000);

      function done(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      fetch(url, { cache: "no-store" }).then(function (response) {
        if (!response.ok) return done({ text: null, error: "HTTP " + response.status });
        return response.text().then(function (text) { done({ text: text, error: null }); });
      }).catch(function (error) {
        done({ text: null, error: String((error && error.message) || error) });
      });
    });
  }

  function refreshCalendars() {
    var sources = calendarUrls();
    if (!sources.length) {
      state.status = "unconfigured";
      state.message = "";
      state.events = [];
      render();
      return Promise.resolve();
    }

    var zone = displayZone();
    var days = Math.max(1, Math.min(5, ICUE.number("agendaDays", 3)));
    var from = ICS.wallToMs(ICS.partsInZone(Date.now(), zone), zone) - DAY_MS;
    var to = from + (days + 2) * DAY_MS;

    return Promise.all(sources.map(function (source) {
      return fetchText(source.url).then(function (result) {
        if (result.error) return { error: source.url.replace(/\/[^/]*$/, "/…") + ": " + result.error };
        if (!/BEGIN:VCALENDAR/i.test(result.text)) {
          return { error: "response was not an ICS feed (is the proxy running?)" };
        }
        try {
          var parsed = ICS.parse(result.text, {
            from: from, to: to, displayZone: zone, sourceIndex: source.sourceIndex
          });
          return { events: parsed.events, name: parsed.calendarName };
        } catch (error) {
          return { error: "could not parse feed: " + String((error && error.message) || error) };
        }
      });
    })).then(function (results) {
      var events = [];
      var names = [];
      var errors = [];

      results.forEach(function (result) {
        if (result.error) { errors.push(result.error); return; }
        events = events.concat(result.events);
        if (result.name) names.push(result.name);
      });

      if (errors.length === results.length) {
        state.status = state.events.length ? "stale" : "error";
        state.message = errors[0];
      } else {
        events.sort(function (a, b) {
          if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
          return a.startMs - b.startMs;
        });
        state.events = events;
        state.calendarNames = names;
        state.updatedAt = Date.now();
        state.status = "live";
        state.message = errors.length ? errors[0] : "";
        ICUE.storageSet("calendar", { events: events, updatedAt: state.updatedAt });
      }

      render();
    });
  }

  /* ----------------------------------------------------------------- weather */

  function refreshWeather() {
    var query = ICUE.string("weatherQuery", "").trim();
    if (!query) {
      state.weather = null;
      state.weatherError = "";
      state.resolvedLocation = null;
      renderWeather();
      return Promise.resolve();
    }

    var cached = ICUE.storageGet("location", null);
    var resolve = cached && cached.query === query
      ? Promise.resolve(cached.location)
      : Weather.resolveLocation(query, ICUE.language).then(function (location) {
          if (location) ICUE.storageSet("location", { query: query, location: location });
          return location;
        });

    return resolve.then(function (location) {
      if (!location) throw new Error("no place matched “" + query + "”");
      state.resolvedLocation = location;
      return Weather.fetchForecast(location, {
        temperatureUnit: ICUE.string("temperatureUnits", "°F"),
        windSpeedUnit: "mph",
        days: 4
      });
    }).then(function (forecast) {
      state.weather = forecast;
      state.weatherError = "";
      ICUE.storageSet("weather", { forecast: forecast, updatedAt: Date.now() });
      renderWeather();
    }).catch(function (error) {
      state.weatherError = String((error && error.message) || error);
      renderWeather();
    });
  }

  function renderWeather() {
    var block = el("weatherBlock");
    var forecast = state.weather;

    if (!forecast) {
      block.setAttribute("data-state", state.weatherError ? "error" : "empty");
      setText("weatherTemp", "");
      ICUE.translate(state.weatherError ? "WEATHER UNAVAILABLE" : "SET A WEATHER LOCATION")
        .then(function (text) { setText("weatherCondition", text); });
      setText("weatherPlace", state.weatherError || "");
      setText("weatherDetail", "");
      el("forecastStrip").textContent = "";
      return;
    }

    block.setAttribute("data-state", "ok");
    el("weatherIcon").firstElementChild.setAttribute("href",
      "#" + Weather.icon(forecast.weatherCode, forecast.isDay));

    setText("weatherTemp", Math.round(forecast.temperature) + "°");
    ICUE.translate(Weather.conditionKey(forecast.weatherCode))
      .then(function (text) { setText("weatherCondition", text); });
    setText("weatherPlace", forecast.locationName);

    var today = forecast.days[0];
    var detail = [];
    if (today && Number.isFinite(today.max)) {
      detail.push("H " + Math.round(today.max) + "°  L " + Math.round(today.min) + "°");
    }
    if (Number.isFinite(forecast.apparentTemperature)) {
      detail.push("Feels " + Math.round(forecast.apparentTemperature) + "°");
    }
    if (Number.isFinite(forecast.windSpeed)) {
      detail.push(Math.round(forecast.windSpeed) + " " + forecast.windSpeedUnit.replace("mp/h", "mph"));
    }
    setText("weatherDetail", detail.join("   ·   "));

    var sun = [];
    if (today && today.sunrise) sun.push("↑ " + formatIsoWallTime(today.sunrise));
    if (today && today.sunset) sun.push("↓ " + formatIsoWallTime(today.sunset));
    setText("weatherSun", sun.join("     "));

    var strip = el("forecastStrip");
    strip.textContent = "";
    var zone = forecast.timezone && ICS.validZone(forecast.timezone) ? forecast.timezone : displayZone();

    forecast.days.slice(1, 4).forEach(function (day) {
      var cell = document.createElement("div");
      cell.className = "forecastDay";

      var name = document.createElement("div");
      name.className = "forecastName";
      var noon = new Date(day.date + "T12:00:00");
      name.textContent = formatter({ timeZone: zone, weekday: "short" }).format(noon).toUpperCase();

      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "forecastIcon");
      var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#" + Weather.icon(day.weatherCode, true));
      svg.appendChild(use);

      var temps = document.createElement("div");
      temps.className = "forecastTemps";
      temps.textContent = Math.round(day.max) + "° / " + Math.round(day.min) + "°";

      var condition = document.createElement("div");
      condition.className = "forecastCondition";
      ICUE.translate(Weather.conditionKey(day.weatherCode)).then(function (text) {
        condition.textContent = text;
      });

      cell.appendChild(name);
      cell.appendChild(svg);
      cell.appendChild(temps);
      cell.appendChild(condition);
      strip.appendChild(cell);
    });
  }

  function formatIsoWallTime(iso) {
    var match = String(iso || "").match(/T(\d{2}):(\d{2})/);
    if (!match) return "";
    var hour = Number(match[1]);
    var minute = match[2];
    if (use24Hour()) return String(hour).padStart(2, "0") + ":" + minute;
    var meridiem = hour < 12 ? "AM" : "PM";
    return (hour % 12 || 12) + ":" + minute + " " + meridiem;
  }

  /* ------------------------------------------------------- opening a link */

  /*
   * iCUE exposes Qt's shell handoff through the linkprovider plugin, declared in
   * manifest.json as "widgetbuilder.linkprovider:Url:1.0". Its QML is literally
   *   function open(link) { Qt.openUrlExternally(link); }
   * so calling it launches the URL in whatever the PC has registered — the browser, or
   * the Zoom/Teams client for their own schemes.
   *
   * The object's name under window.plugins is derived from the module, not the alias
   * ("widgetbuilder.sensorsdataprovider:Sensors" surfaces as plugins.Sensorsdataprovider),
   * so probe the plausible spellings rather than betting on one.
   */
  var LINK_PLUGIN_NAMES = ["Linkprovider", "LinkProvider", "Url", "linkprovider"];

  function linkPlugin() {
    var plugins = globalThis.plugins;
    if (!plugins) return null;
    for (var i = 0; i < LINK_PLUGIN_NAMES.length; i++) {
      var candidate = plugins[LINK_PLUGIN_NAMES[i]];
      if (candidate && typeof candidate.open === "function") return candidate;
    }
    return null;
  }

  function openExternally(url) {
    var plugin = linkPlugin();
    if (plugin) {
      try {
        plugin.open(url);
        return "opened";
      } catch (error) {
        // fall through to the browser attempt
      }
    }
    // Outside iCUE (browser preview) this works; inside, window.open is usually a no-op.
    try {
      var opened = globalThis.open(url, "_blank");
      if (opened) return "opened";
    } catch (error) {}
    return "unavailable";
  }

  /*
   * navigator.clipboard needs a secure context. The file:// origin iCUE serves the widget
   * from qualifies, but the async API can also sit pending forever when the window is not
   * focused, so it is raced against a timeout and falls back to execCommand. The button
   * must always report something back.
   */
  function copyToClipboard(text) {
    var attempt = null;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        attempt = navigator.clipboard.writeText(text).then(function () { return true; },
          function () { return false; });
      }
    } catch (error) {}

    if (!attempt) return Promise.resolve(legacyCopy(text));

    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1200); });
    return Promise.race([attempt, timeout]).then(function (result) {
      // null means it timed out, false means it refused: either way, try the old route.
      return result === true ? true : legacyCopy(text);
    });
  }

  /* execCommand is deprecated but is the only route when the async API is unavailable. */
  function legacyCopy(text) {
    try {
      var field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "readonly");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      field.setSelectionRange(0, text.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(field);
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------------------------------------ invite detail */

  var toastTimer = null;

  function toast(key) {
    var node = el("detailToast");
    if (!node) return;
    setTranslated(node, key);
    node.setAttribute("data-shown", "true");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.removeAttribute("data-shown"); }, 4000);
  }

  function detailWhenText(event, zone) {
    if (event.allDay) {
      var startParts = ICS.partsInZone(event.startMs, zone);
      var label = formatter({ timeZone: zone, weekday: "long", month: "long", day: "numeric" })
        .format(new Date(event.startMs + 12 * 3600000));
      if (event.dayCount > 1) {
        var lastMs = event.startMs + (event.dayCount - 1) * DAY_MS;
        label += " – " + formatter({ timeZone: zone, month: "long", day: "numeric" })
          .format(new Date(lastMs + 12 * 3600000));
      }
      return { line: label, allDayKey: "ALL DAY", unused: startParts };
    }
    return {
      line: formatter({ timeZone: zone, weekday: "long", month: "long", day: "numeric" })
        .format(new Date(event.startMs))
        + "  ·  " + formatTime(event.startMs, zone) + " – " + formatTime(event.endMs, zone)
    };
  }

  function linkRow(link) {
    var row = document.createElement("div");
    row.className = "linkRow";
    row.setAttribute("data-kind", link.kind);

    var text = document.createElement("div");
    text.className = "linkText";

    var label = document.createElement("div");
    label.className = "linkLabel";
    // "www.google.com" is a useless name for the calendar's own event page.
    if (link.kind === "page" && !Links.provider(link.url)) setTranslated(label, "Calendar event");
    else label.textContent = link.label;

    // The full URL is shown so it can be read off the screen and typed by hand — the
    // fallback of last resort if neither opening nor the clipboard works.
    var url = document.createElement("div");
    url.className = "linkUrl";
    url.textContent = link.url;

    text.appendChild(label);
    text.appendChild(url);

    var open = document.createElement("button");
    open.className = "linkButton interactive";
    open.type = "button";
    setTranslated(open, link.kind === "join" ? "JOIN" : "OPEN");
    open.addEventListener("click", function () {
      toast(openExternally(link.url) === "opened" ? "Opening on your PC…" : "Could not open — copy the link instead");
    });

    var copy = document.createElement("button");
    copy.className = "linkButton interactive";
    copy.type = "button";
    copy.setAttribute("data-variant", "quiet");
    setTranslated(copy, "COPY");
    copy.addEventListener("click", function () {
      Promise.resolve(copyToClipboard(link.url)).then(function (ok) {
        toast(ok ? "Link copied to the clipboard" : "Could not copy — type the link shown");
      });
    });

    row.appendChild(text);
    row.appendChild(open);
    row.appendChild(copy);
    return row;
  }

  function factRow(labelKey, value) {
    var row = document.createElement("div");
    row.className = "factRow";

    var label = document.createElement("div");
    label.className = "detailLabel";
    setTranslated(label, labelKey);

    var text = document.createElement("div");
    text.className = "factValue";
    text.textContent = value;

    row.appendChild(label);
    row.appendChild(text);
    return row;
  }

  function openDetail(event) {
    var zone = displayZone();
    state.selected = event;

    el("detailBar").style.background = CALENDAR_COLORS[event.sourceIndex % CALENDAR_COLORS.length];
    setText("detailTitle", event.title);

    var when = detailWhenText(event, zone);
    if (event.allDay) {
      ICUE.translate("ALL DAY").then(function (t) { setText("detailWhen", when.line + "  ·  " + t); });
    } else {
      setText("detailWhen", when.line);
    }

    var links = Links.fromEvent(event);
    var linkBox = el("detailLinks");
    linkBox.textContent = "";
    links.forEach(function (link) { linkBox.appendChild(linkRow(link)); });

    var noLinks = el("detailNoLinks");
    noLinks.hidden = links.length > 0;
    if (!links.length) setTranslated(noLinks, "No links in this invite");

    var facts = el("detailFacts");
    facts.textContent = "";
    if (event.location && !/^https?:\/\//i.test(event.location.trim())) {
      facts.appendChild(factRow("WHERE", event.location.split("\n")[0]));
    }
    if (event.organizer && event.organizer.name) {
      facts.appendChild(factRow("ORGANIZER", event.organizer.name));
    }
    if (event.attendees && event.attendees.length) {
      var names = event.attendees.slice(0, 6).map(function (person) { return person.name; });
      var extra = event.attendees.length - names.length;
      facts.appendChild(factRow("GUESTS",
        names.join(", ") + (extra > 0 ? " +" + extra : "")));
    }

    var notes = Links.plainText(event.description);
    var notesBox = el("detailNotes");
    notesBox.textContent = notes;
    notesBox.setAttribute("data-empty", notes ? "false" : "true");
    if (!notes) setTranslated(notesBox, "No description");

    el("detailToast").removeAttribute("data-shown");
    el("detail").hidden = false;
    el("detailClose").focus();
  }

  function closeDetail() {
    state.selected = null;
    el("detail").hidden = true;
  }

  /* ------------------------------------------------------------------ agenda */

  function eventsForDay(day) {
    return state.events.filter(function (event) {
      if (event.allDay) return event.startDayKey <= day.key && day.key < event.endDayKeyExclusive;
      return event.startMs < day.endMs && event.endMs > day.startMs;
    });
  }

  function makeRow(className) {
    var row = document.createElement("div");
    row.className = className;
    return row;
  }

  /**
   * The one line under an event title. A bare meeting URL is noise at this size, so a
   * URL-shaped location becomes the service's name, and an event whose only clue is a
   * conference field still gets labelled.
   */
  function rowMeta(event) {
    var location = String(event.location || "").split("\n")[0].trim();

    if (/^https?:\/\//i.test(location)) {
      return Links.provider(location) || Links.hostOf(location);
    }
    if (location) return location;
    if (event.conference) {
      return Links.provider(event.conference) || Links.hostOf(event.conference);
    }
    return "";
  }

  function eventRow(event, day, zone, now) {
    var row = document.createElement("button");
    row.className = "event interactive";
    row.type = "button";
    row.style.setProperty("--bar", CALENDAR_COLORS[event.sourceIndex % CALENDAR_COLORS.length]);
    if (event.endMs <= now) row.setAttribute("data-past", "true");
    row.addEventListener("click", function () { openDetail(event); });

    var time = makeRow("eventTime");
    var start = makeRow("eventStart");
    // A timed event running in from an earlier day reads better as a continuation.
    start.textContent = event.startMs < day.startMs ? "→" : formatTime(event.startMs, zone);
    time.appendChild(start);

    if (event.endMs > event.startMs && event.endMs <= day.endMs) {
      var end = makeRow("eventEnd");
      end.textContent = formatTime(event.endMs, zone);
      time.appendChild(end);
    }

    var bar = makeRow("eventBar");

    var body = makeRow("eventBody");
    var title = makeRow("eventTitle");
    title.textContent = event.title;
    body.appendChild(title);

    var meta = rowMeta(event);
    if (meta) {
      var where = makeRow("eventWhere");
      where.textContent = meta;
      body.appendChild(where);
    }

    row.appendChild(time);
    row.appendChild(bar);
    row.appendChild(body);
    return row;
  }

  function nowRow(zone) {
    var row = makeRow("nowLine");
    var label = makeRow("nowTime");
    label.textContent = formatTime(Date.now(), zone);
    var rule = makeRow("nowRule");
    row.appendChild(label);
    row.appendChild(rule);
    return row;
  }

  function moreRow(count, direction) {
    var row = makeRow("moreRow");
    row.setAttribute("data-direction", direction);
    ICUE.translate(direction === "up" ? "earlier" : "more").then(function (word) {
      row.textContent = (direction === "up" ? "↑ " : "↓ ") + count + " " + word;
    });
    return row;
  }

  function renderAgenda() {
    var zone = displayZone();
    var now = Date.now();
    var count = Math.max(1, Math.min(5, ICUE.number("agendaDays", 3)));
    var days = buildDays(count, zone);
    var container = el("agendaColumns");

    container.textContent = "";
    container.style.setProperty("--columns", String(count));

    days.forEach(function (day) {
      var column = document.createElement("section");
      column.className = "dayColumn";
      if (day.isToday) column.setAttribute("data-today", "true");

      var header = document.createElement("header");
      header.className = "dayHeader";

      var name = makeRow("dayName");
      var noon = new Date(day.startMs + 12 * 3600000);
      name.textContent = formatter({ timeZone: zone, weekday: "short" }).format(noon).toUpperCase();

      var number = makeRow("dayNumber");
      number.textContent = formatter({ timeZone: zone, day: "numeric" }).format(noon);

      header.appendChild(name);
      header.appendChild(number);

      if (day.isToday) {
        var badge = makeRow("dayBadge");
        ICUE.translate("TODAY").then(function (text) { badge.textContent = text; });
        header.appendChild(badge);
      }
      column.appendChild(header);

      var body = document.createElement("div");
      body.className = "dayBody";
      column.appendChild(body);
      container.appendChild(column);

      var dayEvents = eventsForDay(day);
      var allDay = dayEvents.filter(function (e) { return e.allDay; });
      var timed = dayEvents.filter(function (e) { return !e.allDay; });

      allDay.slice(0, 2).forEach(function (event) {
        var chip = document.createElement("button");
        chip.className = "allDayChip interactive";
        chip.type = "button";
        chip.style.setProperty("--bar", CALENDAR_COLORS[event.sourceIndex % CALENDAR_COLORS.length]);
        chip.textContent = event.title;
        chip.addEventListener("click", function () { openDetail(event); });
        body.appendChild(chip);
      });
      if (allDay.length > 2) {
        var extra = makeRow("allDayChip");
        extra.setAttribute("data-overflow", "true");
        extra.textContent = "+" + (allDay.length - 2);
        body.appendChild(extra);
      }

      if (!timed.length) {
        var haveData = state.status === "live" || state.status === "stale";
        if (haveData) {
          var empty = makeRow("dayEmpty");
          ICUE.translate(allDay.length ? "No timed events" : "Nothing scheduled")
            .then(function (text) { empty.textContent = text; });
          body.appendChild(empty);
        }
        return;
      }

      // Build the row list, with the now-line spliced in at the right position.
      var rows = timed.map(function (event) {
        return { kind: "event", event: event, node: eventRow(event, day, zone, now) };
      });

      if (day.isToday) {
        var insertAt = rows.findIndex(function (row) { return row.event.startMs > now; });
        if (insertAt < 0) insertAt = rows.length;
        rows.splice(insertAt, 0, { kind: "now", node: nowRow(zone) });
      }

      fillColumn(body, rows, day);
    });
  }

  /**
   * Choose which slice of the row list to show. `anchor` is the index that must stay
   * visible — the now-line for today, the first event otherwise. One row of the budget is
   * given back for each overflow marker we need.
   */
  function fitWindow(total, capacity, anchor) {
    if (total <= capacity) return { start: 0, end: total };

    var start = Math.max(0, Math.min(anchor - 1, total - capacity));
    var budget = capacity - (start > 0 ? 1 : 0);
    var end = Math.min(total, start + Math.max(1, budget));
    if (end < total) end = Math.min(total, start + Math.max(1, budget - 1));
    return { start: start, end: end };
  }

  /**
   * Fill a column to its fixed height, then trim to what actually fits.
   *
   * Fitting is measured off getBoundingClientRect rather than scrollHeight: rows vary in
   * height (the now-line and overflow markers are half an event row) and scrollHeight's
   * treatment of padding-bottom is inconsistent enough to leave a half-clipped last row.
   */
  function fillColumn(body, rows, day) {
    var paddingBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    var limit = body.getBoundingClientRect().bottom - paddingBottom;

    function fits() {
      var last = body.lastElementChild;
      return !last || last.getBoundingClientRect().bottom <= limit;
    }

    var anchor = 0;
    if (day.isToday) {
      var nowIndex = rows.findIndex(function (row) { return row.kind === "now"; });
      anchor = nowIndex < 0 ? 0 : nowIndex;
    }

    var chipsBottom = body.lastElementChild
      ? body.lastElementChild.getBoundingClientRect().bottom
      : body.getBoundingClientRect().top + (parseFloat(getComputedStyle(body).paddingTop) || 0);
    var estimate = Math.max(1, Math.floor((limit - chipsBottom) / rowHeight()));
    var range = fitWindow(rows.length, estimate, anchor);

    function paint(candidate) {
      while (body.lastElementChild && !body.lastElementChild.classList.contains("allDayChip")) {
        body.removeChild(body.lastElementChild);
      }
      if (candidate.start > 0) body.appendChild(moreRow(candidate.start, "up"));
      rows.slice(candidate.start, candidate.end).forEach(function (row) { body.appendChild(row.node); });
      if (candidate.end < rows.length) body.appendChild(moreRow(rows.length - candidate.end, "down"));
    }

    /* The estimate assumes every row is a full-height event, so it under-fills. Grow one
     * row at a time until the column is genuinely full — forwards first, since upcoming
     * events matter more than past ones. */
    function grow(forward) {
      var guard = rows.length + 2;
      while (guard-- > 0) {
        var next = forward
          ? { start: range.start, end: range.end + 1 }
          : { start: range.start - 1, end: range.end };
        if (next.end > rows.length || next.start < 0) return;
        paint(next);
        if (!fits()) { paint(range); return; }
        range = next;
      }
    }

    paint(range);
    if (!fits()) {
      var guard = rows.length + 2;
      while (!fits() && range.end > range.start + 1 && guard-- > 0) {
        range = { start: range.start, end: range.end - 1 };
        paint(range);
      }
    } else {
      grow(true);
      grow(false);
    }
  }

  var cachedRowHeight = 0;
  function rowHeight() {
    if (cachedRowHeight) return cachedRowHeight;
    // --event-row-h is declared in vh and getPropertyValue hands back the raw token, so
    // measure a real row instead. None exists on the very first column, hence the fallback.
    var probe = document.querySelector(".event");
    var measured = probe ? probe.getBoundingClientRect().height : 0;
    if (measured > 4) cachedRowHeight = measured;
    return cachedRowHeight || ROW_HEIGHT_FALLBACK;
  }

  /* ------------------------------------------------------------------ status */

  function renderStatus() {
    var node = el("agendaStatus");
    if (!node) return;

    var keys = { unconfigured: "ADD A CALENDAR URL", error: "OFFLINE", stale: "STALE", live: "" };
    var tones = { unconfigured: "muted", error: "bad", stale: "warn", live: "fresh" };

    node.setAttribute("data-tone", tones[state.status] || "muted");
    node.title = state.message || "";

    ICUE.translate(keys[state.status] === "" ? "UPDATED" : keys[state.status]).then(function (text) {
      if (state.status === "live") {
        var minutes = Math.floor((Date.now() - state.updatedAt) / 60000);
        node.textContent = text + " " + (minutes <= 0 ? "now" : minutes + "m ago");
      } else {
        node.textContent = text;
      }
    });
  }

  function render() {
    document.body.setAttribute("data-status", state.status);
    renderStatus();
    renderAgenda();
  }

  /* --------------------------------------------------------------- lifecycle */

  function scheduleRefresh() {
    clearInterval(timers.refresh);
    var minutes = Math.max(1, Math.min(60, ICUE.number("refreshMinutes", 10)));
    timers.refresh = setInterval(function () {
      refreshCalendars();
      refreshWeather();
    }, minutes * 60000);
  }

  function refreshAll() {
    refreshCalendars();
    refreshWeather();
  }

  ICUE.start({
    onReady: function () {
      var cachedCalendar = ICUE.storageGet("calendar", null);
      if (cachedCalendar && Array.isArray(cachedCalendar.events) && cachedCalendar.events.length) {
        state.events = cachedCalendar.events;
        state.updatedAt = cachedCalendar.updatedAt || 0;
        state.status = "stale";
      }
      var cachedWeather = ICUE.storageGet("weather", null);
      if (cachedWeather && cachedWeather.forecast) state.weather = cachedWeather.forecast;

      applyAppearance();
      el("refreshButton").addEventListener("click", refreshAll);
      el("detailClose").addEventListener("click", closeDetail);
      el("detailScrim").addEventListener("click", closeDetail);
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") closeDetail();
      });

      ICUE.translateDom().then(function () {
        tickClock();
        render();
        renderWeather();
      });

      refreshAll();
      scheduleRefresh();

      // Moves the now-line and re-dims events that have just ended.
      timers.minute = setInterval(function () {
        renderStatus();
        renderAgenda();
      }, 60000);
    },

    onUpdate: function (current, previous) {
      applyAppearance();
      tickClock();

      var calendarChanged = ICUE.changed(previous, current,
        ["calendarUrl1", "calendarUrl2", "calendarUrl3", "proxyBase", "agendaDays", "timeZone"]);
      var weatherChanged = ICUE.changed(previous, current, ["weatherQuery", "temperatureUnits"]);

      if (calendarChanged) refreshCalendars(); else render();
      if (weatherChanged) refreshWeather(); else renderWeather();
      if (ICUE.changed(previous, current, ["refreshMinutes"])) scheduleRefresh();
    },

    onResize: function () {
      cachedRowHeight = 0;
      renderAgenda();
    }
  });
})();
