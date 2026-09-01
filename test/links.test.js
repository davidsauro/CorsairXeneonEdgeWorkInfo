require("../src/js/links.js");
const { check, done } = require("./harness");

console.log("\nprovider recognition");
check("google meet", Links.provider("https://meet.google.com/abc-defg-hij"), "Google Meet");
check("zoom", Links.provider("https://us02web.zoom.us/j/1234567890?pwd=xyz"), "Zoom");
check("teams", Links.provider("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x"), "Microsoft Teams");
check("webex", Links.provider("https://acme.webex.com/meet/dave"), "Webex");
check("unknown host is not a provider", Links.provider("https://example.com/x"), null);
check("a lookalike host is not matched", Links.provider("https://notzoom.us.evil.com/j/1"), null);

console.log("\nGoogle Meet invite (X-GOOGLE-CONFERENCE + plain-text description)");
{
  const event = {
    conference: "https://meet.google.com/abc-defg-hij",
    location: "",
    description: "Join with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial: (US) +1 555-123-4567 PIN: 123456789#\\nMore phone numbers: https://tel.meet/abc-defg-hij?pin=1234",
    eventUrl: "https://www.google.com/calendar/event?eid=abc123"
  };
  const links = Links.fromEvent(event);
  check("meet link is first and labelled", [links[0].label, links[0].kind], ["Google Meet", "join"]);
  check("the duplicate in the description is not repeated",
    links.filter((l) => l.url === event.conference).length, 1);
  check("the dial-in page is kept as a secondary link",
    links.some((l) => l.url.startsWith("https://tel.meet/")), true);
  check("the calendar event page is classed as a page",
    links.find((l) => l.url.includes("google.com/calendar")).kind, "page");
  check("joinable link sorts ahead of the event page", links[0].kind, "join");
}

console.log("\nZoom invite (URL in LOCATION, HTML description)");
{
  const event = {
    conference: "",
    location: "https://us02web.zoom.us/j/1234567890?pwd=aBcD",
    description: '<html><body>Dave is inviting you.<br><a href="https://us02web.zoom.us/j/1234567890?pwd=aBcD">Join Zoom Meeting</a><br>Meeting ID: 123 456 7890<br>Passcode: 4321<br>See the <a href="https://acme.example.com/runbook">runbook</a>.</body></html>',
    eventUrl: ""
  };
  const links = Links.fromEvent(event);
  check("zoom link from LOCATION is first", [links[0].label, links[0].kind], ["Zoom", "join"]);
  check("the same link in an href is deduped", links.length, 2);
  check("the non-meeting href survives as a secondary link",
    [links[1].url, links[1].label], ["https://acme.example.com/runbook", "acme.example.com"]);
}

console.log("\nno links at all");
{
  const links = Links.fromEvent({ conference: "", location: "Room 4B", description: "Bring coffee.", eventUrl: "" });
  check("a room-only invite yields no links", links, []);
  check("a null event yields no links", Links.fromEvent(null), []);
}

console.log("\nURL extraction edge cases");
check("trailing sentence punctuation is dropped",
  Links.extract("See https://example.com/page. Thanks"), ["https://example.com/page"]);
check("a balanced closing paren is kept",
  Links.extract("Docs (https://example.com/a_(b)) here"), ["https://example.com/a_(b)"]);
check("an unbalanced closing paren is dropped",
  Links.extract("Docs (https://example.com/a) here"), ["https://example.com/a"]);
check("query strings survive",
  Links.extract("https://zoom.us/j/1?pwd=a&x=b"), ["https://zoom.us/j/1?pwd=a&x=b"]);
check("entity-encoded ampersands are decoded",
  Links.extract('<a href="https://zoom.us/j/1?pwd=a&amp;x=b">j</a>'), ["https://zoom.us/j/1?pwd=a&x=b"]);
check("mailto and tel are ignored",
  Links.extract("mailto:a@b.com tel:+15551234567"), []);
check("duplicates collapse",
  Links.extract("https://a.example.com https://a.example.com"), ["https://a.example.com"]);

console.log("\ndescription normalisation");
check("br becomes a newline and tags are stripped",
  Links.plainText("Line one<br>Line two<br/>Line three"), "Line one\nLine two\nLine three");
check("entities are decoded",
  Links.plainText("Tom &amp; Jerry &ndash; 10&nbsp;AM &hellip;"), "Tom & Jerry – 10 AM …");
check("numeric entities are decoded", Links.plainText("caf&#233; &#x2713;"), "café ✓");
check("list items get bullets", Links.plainText("<ul><li>One</li><li>Two</li></ul>"), "• One\n• Two");
check("runs of blank lines collapse", Links.plainText("A<br><br><br><br>B"), "A\n\nB");
check("empty input is safe", Links.plainText(null), "");

console.log("\nlink count is capped");
{
  const many = Array.from({ length: 20 }, (_, i) => `https://h${i}.example.com/x`).join(" ");
  check("no more than six links are surfaced",
    Links.fromEvent({ conference: "", location: "", description: many, eventUrl: "" }).length, 6);
}

done();
