/*
 * feed-url.js — turn a calendar address the user pasted into one the widget can fetch.
 *
 * Google's ICS host sends no CORS headers, so calendar.google.com addresses are rewritten
 * onto the companion proxy at github.com/davidsauro/expressProxyforGoogleCalendar, which
 * maps
 *   <base>/proxy/calendar/<rest>  ->  https://calendar.google.com/calendar/<rest>
 *
 * Anything else is passed through untouched, so a feed you already host with permissive
 * CORS keeps working without the proxy.
 */
(function (root) {
  "use strict";

  var GOOGLE = /^https?:\/\/(?:www\.)?(?:calendar\.)?google\.com\/calendar\/(.+)$/i;

  function forProxy(rawUrl, proxyBase) {
    var url = String(rawUrl == null ? "" : rawUrl).trim();
    if (!url) return null;

    // Google offers "webcal://" for subscribe buttons; it is plain https underneath.
    if (/^webcal:\/\//i.test(url)) url = url.replace(/^webcal:\/\//i, "https://");
    if (!/^https?:\/\//i.test(url)) return null;

    var base = String(proxyBase == null ? "" : proxyBase).trim().replace(/\/+$/, "");
    if (!base) return url;

    var match = url.match(GOOGLE);
    // The path is left percent-encoded: the calendar id contains %23 and %40.
    return match ? base + "/proxy/calendar/" + match[1] : url;
  }

  function needsProxy(rawUrl) {
    return GOOGLE.test(String(rawUrl == null ? "" : rawUrl).trim().replace(/^webcal:\/\//i, "https://"));
  }

  root.FeedUrl = { forProxy: forProxy, needsProxy: needsProxy };
})(typeof globalThis !== "undefined" ? globalThis : window);
