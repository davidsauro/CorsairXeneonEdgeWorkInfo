require("../src/js/ics.js");
const fs = require("fs");
const path = require("path");
const { check, done } = require("./harness");

const ZONE = "America/New_York";
const DAY = 86400000;

const parse = (text, from, to) => ICS.parse(text, { from, to, displayZone: ZONE, sourceIndex: 0 });
const cal = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
const at = (ms) => new Date(ms).toLocaleString("en-US", {
  timeZone: ZONE, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
});
const times = (events) => events.map((e) => at(e.startMs));

console.log("\nreal Google feed (all-day events)");
{
  const raw = fs.readFileSync(path.join(__dirname, "fixtures/google-holidays.ics"), "utf8");
  const r = parse(raw, Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 31));
  check("calendar name is read", r.calendarName, "Holidays in United States");
  check("every event is all-day", r.events.every((e) => e.allDay), true);
  const halloween = r.events.find((e) => /Halloween/.test(e.title));
  check("Halloween lands on Oct 31", halloween && halloween.startDayKey, 20261031);
  // X-WR-TIMEZONE is UTC, but an all-day event is a calendar day: it must anchor to
  // midnight in the display zone, or it renders on the previous evening.
  check("all-day anchors to midnight in the display zone", at(halloween.startMs), "Sat, Oct 31, 12:00 AM");
}

console.log("\nweekly recurrence with TZID");
{
  const r = parse(cal(
    "X-WR-TIMEZONE:America/New_York",
    "BEGIN:VEVENT", "UID:w1", "SUMMARY:Standup", "LOCATION:Zoom",
    "DTSTART;TZID=America/New_York:20260902T093000",
    "DTEND;TZID=America/New_York:20260902T094500",
    "RRULE:FREQ=WEEKLY;BYDAY=WE,FR", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 15));
  check("WE+FR across two weeks", times(r.events),
    ["Wed, Sep 2, 09:30 AM", "Fri, Sep 4, 09:30 AM", "Wed, Sep 9, 09:30 AM", "Fri, Sep 11, 09:30 AM"]);
  check("duration is carried to every occurrence",
    r.events.every((e) => e.endMs - e.startMs === 15 * 60000), true);
  check("location survives", r.events[0].location, "Zoom");
}

console.log("\nDST boundary (US falls back Nov 1 2026)");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:d1", "SUMMARY:Daily 8am",
    "DTSTART;TZID=America/New_York:20261029T080000",
    "DTEND;TZID=America/New_York:20261029T083000",
    "RRULE:FREQ=DAILY;COUNT=6", "END:VEVENT"
  ), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 30));
  check("COUNT is honored", r.events.length, 6);
  check("wall-clock time holds across the transition",
    r.events.every((e) => at(e.startMs).includes("08:00 AM")), true);
  check("the UTC instant shifts by an hour",
    new Set(r.events.map((e) => new Date(e.startMs).getUTCHours())).size, 2);
}

console.log("\nEXDATE and RECURRENCE-ID overrides");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:e1", "SUMMARY:Sync",
    "DTSTART;TZID=America/New_York:20260901T100000",
    "DTEND;TZID=America/New_York:20260901T110000",
    "RRULE:FREQ=DAILY;COUNT=5",
    "EXDATE;TZID=America/New_York:20260903T100000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:e1", "SUMMARY:Sync (moved)",
    "RECURRENCE-ID;TZID=America/New_York:20260904T100000",
    "DTSTART;TZID=America/New_York:20260904T140000",
    "DTEND;TZID=America/New_York:20260904T150000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:e1", "SUMMARY:Sync",
    "RECURRENCE-ID;TZID=America/New_York:20260905T100000",
    "DTSTART;TZID=America/New_York:20260905T100000",
    "DTEND;TZID=America/New_York:20260905T110000",
    "STATUS:CANCELLED", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 10));
  check("excluded and cancelled occurrences are dropped, override is moved", times(r.events),
    ["Tue, Sep 1, 10:00 AM", "Wed, Sep 2, 10:00 AM", "Fri, Sep 4, 02:00 PM"]);
  check("the override keeps its own title",
    r.events.find((e) => at(e.startMs).includes("Sep 4")).title, "Sync (moved)");
}

console.log("\nmonthly BYDAY ordinal, UNTIL, folding, escapes");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:m1",
    "SUMMARY:Board meeting\\, Q3 review",
    // RFC 5545 folding: the continuation's leading space is removed and the halves are
    // concatenated with nothing between, so the encoder must keep the word break itself.
    "DESCRIPTION:A long line that is folded across ",
    " multiple physical lines",
    "DTSTART;TZID=America/New_York:20260910T150000",
    "DTEND;TZID=America/New_York:20260910T163000",
    "RRULE:FREQ=MONTHLY;BYDAY=2TH;UNTIL=20261231T235959Z", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2027, 2, 1));
  check("second Thursday of Sep through Dec", times(r.events),
    ["Thu, Sep 10, 03:00 PM", "Thu, Oct 8, 03:00 PM", "Thu, Nov 12, 03:00 PM", "Thu, Dec 10, 03:00 PM"]);
  check("escaped comma is unescaped", r.events[0].title, "Board meeting, Q3 review");
  check("folded line is rejoined",
    r.events[0].description, "A long line that is folded across multiple physical lines");
}

console.log("\nmulti-day all-day event");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:v1", "SUMMARY:Vacation",
    "DTSTART;VALUE=DATE:20260903", "DTEND;VALUE=DATE:20260908", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 10));
  check("spans five days", r.events[0].dayCount, 5);
  check("end day key is exclusive", r.events[0].endDayKeyExclusive, 20260908);
  check("start day key", r.events[0].startDayKey, 20260903);
}

console.log("\nDURATION instead of DTEND");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:dur1", "SUMMARY:Ninety minutes",
    "DTSTART;TZID=America/New_York:20260901T090000",
    "DURATION:PT1H30M", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2));
  check("DURATION is applied", r.events[0].endMs - r.events[0].startMs, 90 * 60000);
}

console.log("\nUTC and floating times");
{
  const r = parse(cal(
    "X-WR-TIMEZONE:Europe/London",
    "BEGIN:VEVENT", "UID:z1", "SUMMARY:Zulu",
    "DTSTART:20260901T140000Z", "DTEND:20260901T150000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:f1", "SUMMARY:Floating",
    "DTSTART:20260901T140000", "DTEND:20260901T150000", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2));
  const zulu = r.events.find((e) => e.title === "Zulu");
  const floating = r.events.find((e) => e.title === "Floating");
  check("Z suffix is treated as UTC", at(zulu.startMs), "Tue, Sep 1, 10:00 AM");
  // A floating time means "the calendar's own zone" — 14:00 London is 09:00 New York.
  check("floating time uses X-WR-TIMEZONE", at(floating.startMs), "Tue, Sep 1, 09:00 AM");
}

console.log("\ncancelled master and malformed input");
{
  const r = parse(cal(
    "BEGIN:VEVENT", "UID:c1", "SUMMARY:Called off",
    "DTSTART;TZID=America/New_York:20260901T090000",
    "DTEND;TZID=America/New_York:20260901T100000", "STATUS:CANCELLED", "END:VEVENT"
  ), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2));
  check("a cancelled event is skipped", r.events.length, 0);
  check("empty input does not throw", parse("", 0, DAY).events.length, 0);
  check("garbage input does not throw", parse("not a calendar", 0, DAY).events.length, 0);
  check("an event with no DTSTART is skipped",
    parse(cal("BEGIN:VEVENT", "UID:x", "SUMMARY:No start", "END:VEVENT"), 0, DAY).events.length, 0);
}

console.log("\nexpansion performance");
{
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push("BEGIN:VEVENT", "UID:p" + i, "SUMMARY:Recurring " + i,
      "DTSTART;TZID=America/New_York:20200106T090000",
      "DTEND;TZID=America/New_York:20200106T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "END:VEVENT");
  }
  const started = Date.now();
  const r = parse(cal(...lines), Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 5));
  const elapsed = Date.now() - started;
  console.log("       200 rules with 6 years of history -> " + r.events.length + " events in " + elapsed + "ms");
  check("skips ahead instead of walking every occurrence", elapsed < 1500, true);
  check("produces the expected occurrence count", r.events.length, 800);
}

done();
