/*
 * links.js — pull the joinable links out of a calendar invite.
 *
 * Invites put the meeting URL in whichever field the originating system felt like:
 * a dedicated conference property, the LOCATION, or buried in a DESCRIPTION that may be
 * plain text or a slab of HTML. This collects them all, in the order a human would try
 * them, and labels each one with the service it belongs to.
 *
 *   Links.fromEvent(event) -> [{ url, label, kind }]     kind: "join" | "page" | "other"
 *   Links.plainText(text)  -> description with tags stripped and entities decoded
 */
(function (root) {
  "use strict";

  var MAX_LINKS = 6;

  /* Longest-match-first so "teams.microsoft.com" beats a bare "microsoft.com". */
  var PROVIDERS = [
    { pattern: /(^|\.)meet\.google\.com$/i, label: "Google Meet" },
    { pattern: /(^|\.)zoom\.us$/i, label: "Zoom" },
    { pattern: /(^|\.)zoomgov\.com$/i, label: "Zoom" },
    { pattern: /(^|\.)teams\.microsoft\.com$/i, label: "Microsoft Teams" },
    { pattern: /(^|\.)teams\.live\.com$/i, label: "Microsoft Teams" },
    { pattern: /(^|\.)webex\.com$/i, label: "Webex" },
    { pattern: /(^|\.)chime\.aws$/i, label: "Amazon Chime" },
    { pattern: /(^|\.)gotomeeting\.com$/i, label: "GoTo Meeting" },
    { pattern: /(^|\.)goto\.com$/i, label: "GoTo Meeting" },
    { pattern: /(^|\.)bluejeans\.com$/i, label: "BlueJeans" },
    { pattern: /(^|\.)whereby\.com$/i, label: "Whereby" },
    { pattern: /(^|\.)around\.co$/i, label: "Around" },
    { pattern: /(^|\.)meet\.jit\.si$/i, label: "Jitsi" },
    { pattern: /(^|\.)slack\.com$/i, label: "Slack" },
    { pattern: /(^|\.)discord\.(gg|com)$/i, label: "Discord" }
  ];

  function hostOf(url) {
    var match = String(url).match(/^https?:\/\/([^/?#]+)/i);
    if (!match) return "";
    return match[1].replace(/:\d+$/, "").toLowerCase();
  }

  /** The service this URL belongs to, or null if it is not a known meeting host. */
  function provider(url) {
    var host = hostOf(url);
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].pattern.test(host)) return PROVIDERS[i].label;
    }
    return null;
  }

  var ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", middot: "·"
  };

  function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (whole, body) {
      if (body.charAt(0) === "#") {
        var code = body.charAt(1).toLowerCase() === "x"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      var named = ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    });
  }

  /** Description bodies arrive as plain text, HTML, or a mixture. Normalise for display. */
  function plainText(raw) {
    return decodeEntities(
      String(raw == null ? "" : raw)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
    )
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* Trailing punctuation is almost always sentence punctuation, not part of the URL —
     but a closing paren is kept when the URL opened one. */
  function trimUrl(url) {
    var trimmed = String(url).replace(/[.,;:!?'"’”>]+$/, "");
    while (/\)$/.test(trimmed)) {
      var opens = (trimmed.match(/\(/g) || []).length;
      var closes = (trimmed.match(/\)/g) || []).length;
      if (closes <= opens) break;
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
  }

  /** Every http(s) URL in a blob of text, including hrefs, in order of appearance. */
  function extract(text) {
    var source = String(text == null ? "" : text);
    var found = [];

    function push(url) {
      var clean = trimUrl(decodeEntities(url).trim());
      if (/^https?:\/\/\S+$/i.test(clean) && found.indexOf(clean) < 0) found.push(clean);
    }

    // Some exporters emit href=\"...\" with the quotes backslash-escaped; tolerate both.
    var href = /href\s*=\s*\\?["']([^"'\\]+)\\?["']/gi;
    var match;
    while ((match = href.exec(source))) push(match[1]);

    // Strip tags before the bare-URL sweep so attribute values are not matched twice.
    // Closing parens are allowed through so trimUrl can decide whether they belong to the
    // URL (a wiki-style path) or to the surrounding sentence.
    var bare = /https?:\/\/[^\s<>"'\]]+[^\s<>"'\].,;:!?]/gi;
    var stripped = source.replace(/<[^>]+>/g, " ");
    while ((match = bare.exec(stripped))) push(match[0]);

    return found;
  }

  /**
   * Links for one event, best first: the dedicated conference field, then the location,
   * then anything in the description, then the calendar's own event page.
   */
  function fromEvent(event) {
    if (!event) return [];
    var seen = {};
    var out = [];

    function add(url, kind) {
      if (!url || out.length >= MAX_LINKS) return;
      var clean = trimUrl(String(url).trim());
      if (!/^https?:\/\//i.test(clean) || seen[clean]) return;
      seen[clean] = true;

      var name = provider(clean);
      out.push({
        url: clean,
        label: name || hostOf(clean) || clean,
        // A known meeting host is something to join; the calendar's own page is not.
        kind: name ? "join" : kind
      });
    }

    add(event.conference, "join");
    extract(event.location).forEach(function (url) { add(url, "other"); });
    extract(event.description).forEach(function (url) { add(url, "other"); });
    add(event.eventUrl, "page");

    // Joinable links first, original order preserved within each group.
    var joins = out.filter(function (l) { return l.kind === "join"; });
    var rest = out.filter(function (l) { return l.kind !== "join"; });
    return joins.concat(rest);
  }

  root.Links = {
    fromEvent: fromEvent,
    extract: extract,
    plainText: plainText,
    provider: provider,
    hostOf: hostOf
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
