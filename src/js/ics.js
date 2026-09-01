/*
 * ics.js — a small RFC 5545 reader, scoped to what Google Calendar actually emits.
 *
 *   ICS.parse(text, { from, to, displayZone, sourceIndex }) -> { calendarName, events }
 *
 * Handles: line unfolding, quoted parameters, VALUE=DATE all-day events, TZID and Z and
 * floating times, DURATION, RRULE expansion (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
 * COUNT, UNTIL, BYDAY incl. ordinals, BYMONTHDAY, BYMONTH), RDATE, EXDATE,
 * RECURRENCE-ID overrides, and STATUS:CANCELLED.
 *
 * Wall-clock -> instant conversion goes through Intl rather than a bundled tzdata, which
 * keeps this dependency-free and DST-correct: guess an instant, ask Intl what wall time
 * that lands on in the target zone, correct by the difference, repeat. Converges in two
 * passes except exactly on a DST boundary.
 */
(function (root) {
  "use strict";

  var MAX_ITERATIONS = 20000;
  var DAY_MS = 86400000;

  /* ------------------------------------------------------------ line handling */

  function unfold(raw) {
    var lines = String(raw == null ? "" : raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === "") continue;
      if ((line.charAt(0) === " " || line.charAt(0) === "\t") && out.length) {
        out[out.length - 1] += line.slice(1);
      } else {
        out.push(line);
      }
    }
    return out;
  }

  function splitUnquoted(text, separator) {
    var parts = [];
    var current = "";
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '"') { quoted = !quoted; current += c; continue; }
      if (c === separator && !quoted) { parts.push(current); current = ""; continue; }
      current += c;
    }
    parts.push(current);
    return parts;
  }

  function parseLine(line) {
    var quoted = false;
    var colon = -1;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') quoted = !quoted;
      else if (c === ":" && !quoted) { colon = i; break; }
    }
    if (colon < 0) return null;

    var segments = splitUnquoted(line.slice(0, colon), ";");
    var name = String(segments.shift() || "").toUpperCase();
    if (!name) return null;

    var params = {};
    segments.forEach(function (segment) {
      var eq = segment.indexOf("=");
      if (eq < 0) return;
      var key = segment.slice(0, eq).toUpperCase();
      var value = segment.slice(eq + 1);
      if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') value = value.slice(1, -1);
      params[key] = value;
    });

    return { name: name, params: params, value: line.slice(colon + 1) };
  }

  function unescapeText(value) {
    return String(value == null ? "" : value)
      .replace(/\\[nN]/g, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\")
      .trim();
  }

  function parseComponents(lines) {
    var tree = { name: "ROOT", props: {}, children: [] };
    var stack = [tree];

    lines.forEach(function (line) {
      var parsed = parseLine(line);
      if (!parsed) return;

      if (parsed.name === "BEGIN") {
        var node = { name: String(parsed.value).toUpperCase().trim(), props: {}, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        return;
      }
      if (parsed.name === "END") {
        if (stack.length > 1) stack.pop();
        return;
      }

      var current = stack[stack.length - 1];
      if (!current.props[parsed.name]) current.props[parsed.name] = [];
      current.props[parsed.name].push(parsed);
    });

    return tree;
  }

  function first(component, name) {
    var list = component.props[name];
    return list && list.length ? list[0] : null;
  }

  function all(component, name) {
    return component.props[name] || [];
  }

  function text(component, name, fallback) {
    var item = first(component, name);
    return item ? unescapeText(item.value) : (fallback || "");
  }

  function collect(component, name, out) {
    out = out || [];
    if (component.name === name) out.push(component);
    component.children.forEach(function (child) { collect(child, name, out); });
    return out;
  }

  /* --------------------------------------------------------------- time zones */

  var zoneValid = {};
  var zoneFormat = {};

  function validZone(zone) {
    if (!zone) return false;
    if (zone in zoneValid) return zoneValid[zone];
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
      zoneValid[zone] = true;
    } catch (error) {
      zoneValid[zone] = false;
    }
    return zoneValid[zone];
  }

  function formatter(zone) {
    if (!zoneFormat[zone]) {
      zoneFormat[zone] = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      });
    }
    return zoneFormat[zone];
  }

  function partsInZone(ms, zone) {
    var out = {};
    formatter(zone).formatToParts(new Date(ms)).forEach(function (part) {
      if (part.type !== "literal") out[part.type] = Number(part.value);
    });
    return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second };
  }

  function utcOf(parts) {
    return Date.UTC(parts.y, parts.m - 1, parts.d, parts.h || 0, parts.min || 0, parts.s || 0);
  }

  /** Wall-clock parts in `zone` -> UTC milliseconds. */
  function wallToMs(parts, zone) {
    var desired = utcOf(parts);
    if (!zone || zone === "UTC" || !validZone(zone)) return desired;

    var guess = desired;
    for (var i = 0; i < 3; i++) {
      var delta = desired - utcOf(partsInZone(guess, zone));
      if (delta === 0) break;
      guess += delta;
    }
    return guess;
  }

  /* ------------------------------------------------------- value parsing */

  var DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

  function parseDateValue(item, zones, aliases) {
    var value = String(item.value || "").trim();
    var match = value.match(DATE_RE);
    if (!match) return null;

    var parts = {
      y: Number(match[1]), m: Number(match[2]), d: Number(match[3]),
      h: Number(match[4] || 0), min: Number(match[5] || 0), s: Number(match[6] || 0)
    };

    var declaredDate = String(item.params.VALUE || "").toUpperCase() === "DATE";
    if (declaredDate || !match[4]) {
      var dayZone = zones.dateOnly;
      return {
        dateOnly: true,
        parts: parts,
        zone: dayZone,
        ms: wallToMs({ y: parts.y, m: parts.m, d: parts.d }, dayZone)
      };
    }

    var zone;
    if (match[7] === "Z") {
      zone = "UTC";
    } else {
      var tzid = String(item.params.TZID || "");
      if (aliases && aliases[tzid]) tzid = aliases[tzid];
      zone = validZone(tzid) ? tzid : zones.floating;
    }

    return { dateOnly: false, parts: parts, zone: zone, ms: wallToMs(parts, zone) };
  }

  function parseDurationMs(value) {
    var match = String(value || "").trim()
      .match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!match) return null;
    var ms = (Number(match[2] || 0) * 7 + Number(match[3] || 0)) * DAY_MS
      + Number(match[4] || 0) * 3600000
      + Number(match[5] || 0) * 60000
      + Number(match[6] || 0) * 1000;
    return match[1] === "-" ? -ms : ms;
  }

  /*
   * Where the various calendar systems put the join link:
   *   X-GOOGLE-CONFERENCE            Google Calendar, for Meet
   *   CONFERENCE;VALUE=URI           RFC 7986, the standard field
   *   X-MICROSOFT-SKYPETEAMSMEETINGURL   Outlook, for Teams
   * Zoom and most others only put it in LOCATION or DESCRIPTION.
   */
  var CONFERENCE_FIELDS = ["X-GOOGLE-CONFERENCE", "CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL"];

  function conferenceUrl(component) {
    for (var i = 0; i < CONFERENCE_FIELDS.length; i++) {
      var item = first(component, CONFERENCE_FIELDS[i]);
      if (item && /^https?:\/\//i.test(String(item.value).trim())) return String(item.value).trim();
    }
    return "";
  }

  /** "ORGANIZER;CN=Alex Rivera:mailto:alex@example.com" -> { name, email } */
  function personOf(item) {
    if (!item) return null;
    var email = String(item.value || "").replace(/^mailto:/i, "").trim();
    var name = unescapeText(item.params.CN || "").trim();
    if (!name && !email) return null;
    return {
      name: name || email,
      email: email,
      status: String(item.params.PARTSTAT || "").toUpperCase()
    };
  }

  function organizerOf(component) {
    return personOf(first(component, "ORGANIZER"));
  }

  function attendeesOf(component) {
    var out = [];
    all(component, "ATTENDEE").forEach(function (item) {
      var person = personOf(item);
      // Resource rows (rooms) are not people and clutter the list.
      if (person && String(item.params.CUTYPE || "").toUpperCase() !== "RESOURCE") out.push(person);
    });
    return out;
  }

  /* Zone aliases from VTIMEZONE, for the rare non-IANA TZID. */
  function timezoneAliases(tree) {
    var aliases = {};
    collect(tree, "VTIMEZONE").forEach(function (component) {
      var id = text(component, "TZID", "");
      if (!id || validZone(id)) return;
      var location = text(component, "X-LIC-LOCATION", "");
      if (location && validZone(location)) aliases[id] = location;
    });
    return aliases;
  }

  /* ------------------------------------------------------------------- RRULE */

  var WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  function parseByDay(token) {
    var match = String(token).trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    return { ordinal: match[1] ? Number(match[1]) : 0, weekday: WEEKDAY[match[2]] };
  }

  function parseRrule(value) {
    var rule = {
      freq: "", interval: 1, count: null, untilRaw: null,
      byday: [], bymonthday: [], bymonth: [], wkst: "MO"
    };

    String(value).split(";").forEach(function (pair) {
      var eq = pair.indexOf("=");
      if (eq < 0) return;
      var key = pair.slice(0, eq).toUpperCase();
      var val = pair.slice(eq + 1);

      if (key === "FREQ") rule.freq = val.toUpperCase();
      else if (key === "INTERVAL") rule.interval = Math.max(1, parseInt(val, 10) || 1);
      else if (key === "COUNT") rule.count = Math.max(1, parseInt(val, 10) || 1);
      else if (key === "UNTIL") rule.untilRaw = val.trim();
      else if (key === "WKST") rule.wkst = val.toUpperCase();
      else if (key === "BYDAY") {
        rule.byday = val.split(",").map(parseByDay).filter(Boolean);
      } else if (key === "BYMONTHDAY") {
        rule.bymonthday = val.split(",").map(Number).filter(function (n) { return Number.isFinite(n) && n !== 0; });
      } else if (key === "BYMONTH") {
        rule.bymonth = val.split(",").map(Number).filter(function (n) { return n >= 1 && n <= 12; });
      }
    });

    return rule;
  }

  /* Plain-calendar helpers; all arithmetic happens on wall-clock parts. */
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function dayNumber(parts) { return Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / DAY_MS); }
  function weekday(parts) { return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay(); }

  function fromDayNumber(n) {
    var date = new Date(n * DAY_MS);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }

  function withTime(day, time) {
    return { y: day.y, m: day.m, d: day.d, h: time.h || 0, min: time.min || 0, s: time.s || 0 };
  }

  /** Resolve BYDAY/BYMONTHDAY within one month into a sorted list of day-of-month values. */
  function daysInPeriod(y, m, rule, startDay) {
    var length = daysInMonth(y, m);
    var days = [];

    if (rule.bymonthday.length) {
      rule.bymonthday.forEach(function (d) {
        var resolved = d > 0 ? d : length + d + 1;
        if (resolved >= 1 && resolved <= length) days.push(resolved);
      });
    } else if (rule.byday.length) {
      rule.byday.forEach(function (entry) {
        var matches = [];
        for (var d = 1; d <= length; d++) {
          if (weekday({ y: y, m: m, d: d }) === entry.weekday) matches.push(d);
        }
        if (!entry.ordinal) {
          days = days.concat(matches);
        } else if (entry.ordinal > 0) {
          if (matches[entry.ordinal - 1]) days.push(matches[entry.ordinal - 1]);
        } else if (matches[matches.length + entry.ordinal]) {
          days.push(matches[matches.length + entry.ordinal]);
        }
      });
    } else {
      if (startDay <= length) days.push(startDay);
    }

    return days.filter(function (d, i, list) { return list.indexOf(d) === i; })
               .sort(function (a, b) { return a - b; });
  }

  /**
   * Walk the recurrence set in order, emitting wall-clock start parts inside [from, to].
   * Stops on COUNT, UNTIL, the window end, or a hard iteration cap.
   */
  function expandRule(start, rule, zone, fromMs, toMs, untilMs) {
    var results = [];
    var emitted = 0;
    var iterations = 0;
    var startDayNumber = dayNumber(start);

    function consider(day) {
      if (dayNumber(day) < startDayNumber) return true;
      if (rule.bymonth.length && rule.bymonth.indexOf(day.m) < 0) return true;

      var parts = withTime(day, start);
      var ms = wallToMs(parts, zone);

      emitted++;
      if (rule.count !== null && emitted > rule.count) return false;
      if (untilMs !== null && ms > untilMs) return false;
      if (ms > toMs) return false;
      if (ms >= fromMs) results.push({ parts: parts, ms: ms });
      return true;
    }

    // Skipping ahead is only safe when COUNT isn't limiting the set.
    var skip = 0;
    if (rule.count === null) {
      var fromDay = Math.floor(fromMs / DAY_MS);
      if (rule.freq === "DAILY") skip = Math.floor((fromDay - startDayNumber) / rule.interval);
      else if (rule.freq === "WEEKLY") skip = Math.floor((fromDay - startDayNumber) / (7 * rule.interval));
      else if (rule.freq === "MONTHLY") {
        var fromParts = partsInZone(fromMs, zone);
        skip = Math.floor(((fromParts.y - start.y) * 12 + (fromParts.m - start.m)) / rule.interval);
      } else if (rule.freq === "YEARLY") {
        skip = Math.floor((partsInZone(fromMs, zone).y - start.y) / rule.interval);
      }
      skip = Math.max(0, skip - 1);
    }

    var weekAnchor = null;
    if (rule.freq === "WEEKLY") {
      var wkst = WEEKDAY[rule.wkst] === undefined ? 1 : WEEKDAY[rule.wkst];
      weekAnchor = startDayNumber - ((weekday(start) - wkst + 7) % 7);
    }

    for (var k = skip; ; k++) {
      if (++iterations > MAX_ITERATIONS) break;

      var days = [];

      if (rule.freq === "DAILY") {
        days = [fromDayNumber(startDayNumber + k * rule.interval)];
      } else if (rule.freq === "WEEKLY") {
        var weekStart = weekAnchor + k * 7 * rule.interval;
        var weekdays = rule.byday.length
          ? rule.byday.map(function (entry) { return entry.weekday; })
          : [weekday(start)];
        var wkstDay = WEEKDAY[rule.wkst] === undefined ? 1 : WEEKDAY[rule.wkst];
        days = weekdays
          .map(function (wd) { return weekStart + ((wd - wkstDay + 7) % 7); })
          .sort(function (a, b) { return a - b; })
          .map(fromDayNumber);
      } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
        var monthOffset = rule.freq === "MONTHLY" ? k * rule.interval : 0;
        var year = start.y + (rule.freq === "YEARLY" ? k * rule.interval : 0) + Math.floor((start.m - 1 + monthOffset) / 12);
        var month = ((start.m - 1 + monthOffset) % 12 + 12) % 12 + 1;
        var months = rule.freq === "YEARLY" && rule.bymonth.length ? rule.bymonth : [month];
        months.forEach(function (mm) {
          daysInPeriod(year, mm, rule, start.d).forEach(function (d) { days.push({ y: year, m: mm, d: d }); });
        });
        days.sort(function (a, b) { return dayNumber(a) - dayNumber(b); });
      } else {
        // Unknown or missing FREQ: treat as a single occurrence.
        days = [{ y: start.y, m: start.m, d: start.d }];
      }

      var keepGoing = true;
      for (var i = 0; i < days.length; i++) {
        if (!consider(days[i])) { keepGoing = false; break; }
      }
      if (!keepGoing) break;

      // Nothing left to find: every candidate this period is already past the window.
      if (days.length && wallToMs(withTime(days[days.length - 1], start), zone) > toMs) break;
      if (rule.freq !== "DAILY" && rule.freq !== "WEEKLY" && rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") break;
    }

    return results;
  }

  /* ------------------------------------------------------------- normalizing */

  function occurrenceKey(value) {
    if (!value) return null;
    return value.dateOnly
      ? "d:" + value.parts.y + pad(value.parts.m) + pad(value.parts.d)
      : "t:" + value.ms;
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function dayKeyFromParts(parts) { return parts.y * 10000 + parts.m * 100 + parts.d; }

  function addDays(parts, amount) { return fromDayNumber(dayNumber(parts) + amount); }

  function makeEvent(template, startParts, startMs, options, keySuffix) {
    var event = {
      uid: template.uid,
      id: template.uid + "#" + keySuffix + "@" + options.sourceIndex,
      title: template.title || "(no title)",
      location: template.location,
      description: template.description,
      conference: template.conference,
      eventUrl: template.eventUrl,
      organizer: template.organizer,
      attendees: template.attendees,
      allDay: template.allDay,
      sourceIndex: options.sourceIndex,
      startMs: startMs,
      endMs: startMs + template.durationMs
    };

    if (template.allDay) {
      event.startDayKey = dayKeyFromParts(startParts);
      var days = Math.max(1, Math.round(template.durationMs / DAY_MS));
      event.endDayKeyExclusive = dayKeyFromParts(addDays(startParts, days));
      event.dayCount = days;
      event.endMs = wallToMs(addDays(startParts, days), options.displayZone);
    }

    return event;
  }

  function buildTemplate(component, zones, aliases) {
    var dtstartItem = first(component, "DTSTART");
    if (!dtstartItem) return null;

    var dtstart = parseDateValue(dtstartItem, zones, aliases);
    if (!dtstart) return null;

    var durationMs = null;
    var dtendItem = first(component, "DTEND");
    if (dtendItem) {
      var dtend = parseDateValue(dtendItem, zones, aliases);
      if (dtend) durationMs = dtend.ms - dtstart.ms;
    }
    if (durationMs === null) {
      var durationItem = first(component, "DURATION");
      if (durationItem) durationMs = parseDurationMs(durationItem.value);
    }
    if (durationMs === null || durationMs < 0) durationMs = dtstart.dateOnly ? DAY_MS : 0;
    if (dtstart.dateOnly && durationMs < DAY_MS) durationMs = DAY_MS;

    var recurrenceItem = first(component, "RECURRENCE-ID");
    var rruleItem = first(component, "RRULE");

    return {
      uid: text(component, "UID", "") || "no-uid",
      title: text(component, "SUMMARY", ""),
      location: text(component, "LOCATION", ""),
      description: text(component, "DESCRIPTION", ""),
      conference: conferenceUrl(component),
      eventUrl: text(component, "URL", ""),
      organizer: organizerOf(component),
      attendees: attendeesOf(component),
      allDay: dtstart.dateOnly,
      zone: dtstart.zone,
      startParts: dtstart.parts,
      startMs: dtstart.ms,
      durationMs: durationMs,
      cancelled: text(component, "STATUS", "").toUpperCase() === "CANCELLED",
      rrule: rruleItem ? parseRrule(rruleItem.value) : null,
      recurrenceKey: recurrenceItem ? occurrenceKey(parseDateValue(recurrenceItem, zones, aliases)) : null,
      sequence: Number(text(component, "SEQUENCE", "0")) || 0,
      component: component
    };
  }

  function dateListKeys(component, name, zones, aliases) {
    var keys = {};
    all(component, name).forEach(function (item) {
      String(item.value).split(",").forEach(function (piece) {
        var key = occurrenceKey(parseDateValue({ value: piece, params: item.params }, zones, aliases));
        if (key) keys[key] = true;
      });
    });
    return keys;
  }

  /* -------------------------------------------------------------------- entry */

  function parse(raw, options) {
    options = options || {};
    var displayZone = options.displayZone && validZone(options.displayZone)
      ? options.displayZone
      : (function () {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
          catch (error) { return "UTC"; }
        })();

    var sourceIndex = Number(options.sourceIndex || 0);
    var from = Number(options.from);
    var to = Number(options.to);
    if (!Number.isFinite(from)) from = Date.now() - DAY_MS;
    if (!Number.isFinite(to)) to = from + 14 * DAY_MS;

    var tree = parseComponents(unfold(raw));
    var calendar = collect(tree, "VCALENDAR")[0] || tree;
    var aliases = timezoneAliases(tree);
    var floatingZone = text(calendar, "X-WR-TIMEZONE", "");
    if (!validZone(floatingZone)) floatingZone = displayZone;

    // Floating times mean "the calendar's own zone"; all-day dates mean "a calendar day",
    // which only makes sense anchored to the zone we are rendering in.
    var zones = { floating: floatingZone, dateOnly: displayZone };
    var settings = { sourceIndex: sourceIndex, displayZone: displayZone };
    var components = collect(tree, "VEVENT");

    // Split masters from RECURRENCE-ID overrides before expanding anything.
    var masters = [];
    var overrides = {};
    components.forEach(function (component) {
      var template = buildTemplate(component, zones, aliases);
      if (!template) return;
      if (template.recurrenceKey) {
        var bucket = overrides[template.uid] || (overrides[template.uid] = {});
        var existing = bucket[template.recurrenceKey];
        if (!existing || template.sequence >= existing.sequence) bucket[template.recurrenceKey] = template;
      } else {
        masters.push(template);
      }
    });

    var events = [];

    masters.forEach(function (template) {
      if (template.cancelled) return;

      var excluded = dateListKeys(template.component, "EXDATE", zones, aliases);
      var bucket = overrides[template.uid] || {};

      function emit(startParts, startMs, key) {
        if (excluded[key]) return;

        var override = bucket[key];
        if (override) {
          if (override.cancelled) return;
          if (override.startMs + override.durationMs < from || override.startMs > to) return;
          events.push(makeEvent(override, override.startParts, override.startMs, settings, key));
          return;
        }
        if (startMs + template.durationMs < from || startMs > to) return;
        events.push(makeEvent(template, startParts, startMs, settings, key));
      }

      if (!template.rrule) {
        emit(template.startParts, template.startMs, occurrenceKey({
          dateOnly: template.allDay, parts: template.startParts, ms: template.startMs
        }));
      } else {
        var untilMs = null;
        if (template.rrule.untilRaw) {
          var until = parseDateValue({ value: template.rrule.untilRaw, params: {} },
            { floating: template.zone, dateOnly: template.zone }, aliases);
          if (until) untilMs = until.dateOnly ? until.ms + DAY_MS : until.ms;
        }

        // Reach back far enough that a long event starting before the window still shows.
        var searchFrom = from - Math.max(template.durationMs, DAY_MS) - DAY_MS;

        expandRule(template.startParts, template.rrule, template.zone, searchFrom, to, untilMs)
          .forEach(function (occurrence) {
            emit(occurrence.parts, occurrence.ms, occurrenceKey({
              dateOnly: template.allDay, parts: occurrence.parts, ms: occurrence.ms
            }));
          });
      }

      // RDATE additions, which Google uses for irregular repeats.
      all(template.component, "RDATE").forEach(function (item) {
        String(item.value).split(",").forEach(function (piece) {
          var value = parseDateValue({ value: piece, params: item.params },
            { floating: template.zone, dateOnly: template.zone }, aliases);
          if (!value) return;
          emit(value.parts, value.ms, occurrenceKey(value));
        });
      });
    });

    // Two calendars can carry the same event; keep one per uid+start.
    var seen = {};
    var unique = [];
    events.forEach(function (event) {
      var key = event.uid + "|" + event.startMs + "|" + event.allDay;
      if (seen[key]) return;
      seen[key] = true;
      unique.push(event);
    });

    unique.sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.startMs - b.startMs || String(a.title).localeCompare(String(b.title));
    });

    return {
      calendarName: text(calendar, "X-WR-CALNAME", ""),
      timezone: floatingZone,
      events: unique
    };
  }

  root.ICS = { parse: parse, wallToMs: wallToMs, partsInZone: partsInZone, validZone: validZone };
})(typeof globalThis !== "undefined" ? globalThis : window);
