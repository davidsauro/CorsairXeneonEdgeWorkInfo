require("../src/js/feed-url.js");
const { check, done } = require("./harness");

const PROXY = "http://localhost:8010";
const SECRET = "https://calendar.google.com/calendar/ical/dave%40example.com/private-abc123/basic.ics";

check("google secret ics is routed through the proxy",
  FeedUrl.forProxy(SECRET, PROXY),
  PROXY + "/proxy/calendar/ical/dave%40example.com/private-abc123/basic.ics");

check("percent-encoding is preserved, not decoded",
  FeedUrl.forProxy("https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics", PROXY),
  PROXY + "/proxy/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics");

check("webcal:// is upgraded then proxied",
  FeedUrl.forProxy("webcal://calendar.google.com/calendar/ical/x/private-y/basic.ics", PROXY),
  PROXY + "/proxy/calendar/ical/x/private-y/basic.ics");

check("legacy www.google.com/calendar form is proxied",
  FeedUrl.forProxy("https://www.google.com/calendar/ical/x/private-y/basic.ics", PROXY),
  PROXY + "/proxy/calendar/ical/x/private-y/basic.ics");

check("a trailing slash on the proxy base does not double up",
  FeedUrl.forProxy(SECRET, PROXY + "///"),
  PROXY + "/proxy/calendar/ical/dave%40example.com/private-abc123/basic.ics");

check("a non-Google feed is passed through untouched",
  FeedUrl.forProxy("https://example.com/team.ics", PROXY),
  "https://example.com/team.ics");

check("an already-proxied url is not rewritten twice",
  FeedUrl.forProxy(PROXY + "/proxy/calendar/ical/x/private-y/basic.ics", PROXY),
  PROXY + "/proxy/calendar/ical/x/private-y/basic.ics");

check("no proxy configured falls back to the raw url",
  FeedUrl.forProxy(SECRET, ""),
  SECRET);

check("empty input yields null", FeedUrl.forProxy("", PROXY), null);
check("whitespace-only input yields null", FeedUrl.forProxy("   ", PROXY), null);
check("a non-http scheme is rejected", FeedUrl.forProxy("file:///etc/passwd", PROXY), null);
check("a bare path is rejected", FeedUrl.forProxy("basic.ics", PROXY), null);

check("needsProxy is true for google", FeedUrl.needsProxy(SECRET), true);
check("needsProxy is false for other hosts", FeedUrl.needsProxy("https://example.com/a.ics"), false);

done();
