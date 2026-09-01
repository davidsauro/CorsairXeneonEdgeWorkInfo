/*
 * color.js — normalise whatever iCUE hands us into something CSS can actually use.
 *
 * iCUE stores colours the way Qt serialises QColor, which is not CSS:
 *
 *   rgb(0.941176 0.556863 0.2)   normalised 0..1 floats, space separated
 *   rgb(1 1 1)                   white — CSS would read this as near-black
 *   hsv(0.681694 0.754467 0.94)  CSS has no hsv() at all, so the declaration is dropped
 *
 * Assigning those straight into a custom property silently produces black, or nothing.
 * Every colour arriving from a widget property goes through Color.toCss() first.
 *
 *   Color.toCss(value) -> "#rrggbb" | null
 */
(function (root) {
  "use strict";

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  function hex2(n) {
    var v = Math.round(clamp01(n) * 255);
    return (v < 16 ? "0" : "") + v.toString(16);
  }

  function fromRgbUnit(r, g, b) { return "#" + hex2(r) + hex2(g) + hex2(b); }

  /* Qt's HSV: all three components normalised 0..1. */
  function hsvToCss(h, s, v) {
    h = ((h % 1) + 1) % 1;
    s = clamp01(s);
    v = clamp01(v);

    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0: return fromRgbUnit(v, t, p);
      case 1: return fromRgbUnit(q, v, p);
      case 2: return fromRgbUnit(p, v, t);
      case 3: return fromRgbUnit(p, q, v);
      case 4: return fromRgbUnit(t, p, v);
      default: return fromRgbUnit(v, p, q);
    }
  }

  function numbers(body) {
    var parts = String(body).trim().split(/[\s,\/]+/).filter(function (p) { return p !== ""; });
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseFloat(parts[i].replace("%", ""));
      if (!Number.isFinite(n)) return null;
      out.push(parts[i].indexOf("%") >= 0 ? n / 100 : n);
    }
    return out;
  }

  function toCss(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;

    // Already-valid CSS hex. 8-digit is left alone: CSS reads #RRGGBBAA and Qt writes
    // #AARRGGBB, and there is no way to tell them apart from the text, so guessing here
    // would break one of the two.
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text;

    var match = text.match(/^(rgba?|hsva?|hsla?)\s*\(([^)]*)\)$/i);
    if (match) {
      var fn = match[1].toLowerCase();
      var n = numbers(match[2]);
      if (!n || n.length < 3) return null;

      if (fn === "hsv" || fn === "hsva") return hsvToCss(n[0], n[1], n[2]);
      if (fn === "hsl" || fn === "hsla") return text;  // CSS understands hsl natively

      // rgb: Qt writes normalised floats, CSS uses 0-255. A component above 1 can only
      // be the 0-255 form; everything at or below 1 is Qt's.
      var maxComponent = Math.max(n[0], n[1], n[2]);
      if (maxComponent <= 1) return fromRgbUnit(n[0], n[1], n[2]);
      return fromRgbUnit(n[0] / 255, n[1] / 255, n[2] / 255);
    }

    // A bare CSS keyword (or anything else); let CSS judge it.
    if (/^[a-z]+$/i.test(text)) return text;
    return null;
  }

  root.Color = { toCss: toCss };
})(typeof globalThis !== "undefined" ? globalThis : window);
