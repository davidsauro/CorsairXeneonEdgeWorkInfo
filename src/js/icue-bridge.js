/*
 * icue-bridge.js — a thin, dependency-free wrapper over the iCUE HTML widget host.
 *
 * What the host gives a widget (all of it global, none of it namespaced):
 *   <propertyName>            one bare global per x-icue-property, holding its current value
 *   iCUE_initialized          boolean; true once the host has injected everything
 *   iCUE.iCUELanguage         "en" | "de" | "es" | "fr" | ...
 *   iCUE.allTimeZones()       list for a combobox (settings panel only)
 *   iCUE.defaultTimeZone()    IANA zone string, sometimes with a trailing " (UTC+x)" suffix
 *   iCUE.default24HourFormat()  "12h" | "24h"
 *   uniqueId                  stable id for THIS placed instance of the widget
 *   tr(key)                   returns a Promise<string> resolved from translation.json
 *   icueEvents = { onICUEInitialized, onDataUpdated }   callbacks you assign
 *   window.plugins.<Name>     Qt WebChannel objects, only if declared in required_plugins
 *
 * Two hazards this file exists to absorb:
 *   1. Property globals may be lexically scoped (let/const), so globalThis[name] is
 *      undefined even though `name` resolves. We re-expose them via an accessor.
 *   2. Every element with an id also becomes a window global, so a property named the
 *      same as an element id reads back as a DOM Node. We filter those out.
 */
(function (root) {
  "use strict";

  var PROPERTY_NAMES = [];
  var DECLARED_DEFAULTS = {};

  var insideICUE = typeof root.tr === "function";

  /**
   * data-default holds an expression iCUE evaluates, not a literal. Outside iCUE we
   * recognise the handful of forms the widget actually uses so a plain browser can render
   * the real defaults instead of a page full of blanks.
   */
  function evaluateDefault(expression) {
    var text = String(expression == null ? "" : expression).trim();
    if (!text) return undefined;
    if (/^'[\s\S]*'$/.test(text) || /^"[\s\S]*"$/.test(text)) return text.slice(1, -1);
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "iCUE.defaultTimeZone()") {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
      catch (error) { return "UTC"; }
    }
    if (text === "iCUE.default24HourFormat()") return "12h";
    return undefined;
  }

  try {
    var metas = document.querySelectorAll('meta[name="x-icue-property"]');
    for (var i = 0; i < metas.length; i++) {
      var name = metas[i].getAttribute("content");
      if (!name) continue;
      PROPERTY_NAMES.push(name);
      var declared = evaluateDefault(metas[i].getAttribute("data-default"));
      if (declared !== undefined) DECLARED_DEFAULTS[name] = declared;
    }
  } catch (error) {}

  /**
   * A URL query parameter is always a string, but a slider property needs a number and a
   * switch needs a boolean. Coerce using the *declared default's* type rather than
   * guessing from the text: guessing turns the ZIP code "02110" into the number 2110,
   * which geocodes to Belgium.
   */
  function coerce(value, name) {
    var declared = DECLARED_DEFAULTS[name];

    if (typeof declared === "number") {
      var n = Number(value);
      return Number.isFinite(n) ? n : declared;
    }
    if (typeof declared === "boolean") return value === "true" || value === "1";
    if (typeof declared === "string") return value;

    // No declared default to learn from: only treat it as a number if nothing is lost.
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(value) && String(Number(value)) === value) return Number(value);
    return value;
  }

  /* Outside iCUE, ?name=value in the URL stands in for the settings panel. */
  var URL_OVERRIDES = {};
  if (!insideICUE) {
    try {
      new URLSearchParams(location.search).forEach(function (value, key) {
        if (PROPERTY_NAMES.indexOf(key) < 0) return;
        URL_OVERRIDES[key] = coerce(value, key);
      });
    } catch (error) {}
  }

  // Hazard 1: surface lexically-scoped property globals on globalThis.
  PROPERTY_NAMES.forEach(function (name) {
    try {
      if (Object.prototype.hasOwnProperty.call(root, name)) return;
      var resolve = new Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined;");
      if (resolve() === undefined) return;
      Object.defineProperty(root, name, {
        configurable: true,
        enumerable: true,
        get: function () {
          try { return resolve(); } catch (error) { return undefined; }
        }
      });
    } catch (error) {}
  });

  /**
   * Read one widget property. Resolution order: the value iCUE injected, then a URL
   * override (browser preview only), then the declared data-default, then the caller's
   * fallback.
   */
  function prop(name, fallback) {
    try {
      var value = root[name];
      // Hazard 2: an id-named element shadowing the property.
      if (typeof Node !== "undefined" && value instanceof Node) value = undefined;
      if (value !== undefined && value !== null && value !== "") return value;
    } catch (error) {}

    if (Object.prototype.hasOwnProperty.call(URL_OVERRIDES, name)) return URL_OVERRIDES[name];
    if (Object.prototype.hasOwnProperty.call(DECLARED_DEFAULTS, name)) return DECLARED_DEFAULTS[name];
    return fallback;
  }

  function propString(name, fallback) { return String(prop(name, fallback)); }
  function propNumber(name, fallback) {
    var n = Number(prop(name, fallback));
    return Number.isFinite(n) ? n : fallback;
  }
  function propBool(name, fallback) {
    var v = prop(name, fallback);
    return v === true || v === "true";
  }

  /** Snapshot of every property, for cheap change detection in onDataUpdated. */
  function snapshot() {
    var out = {};
    PROPERTY_NAMES.forEach(function (name) { out[name] = prop(name, null); });
    return out;
  }

  function changed(before, after, names) {
    if (!before) return true;
    var keys = names || PROPERTY_NAMES;
    for (var i = 0; i < keys.length; i++) {
      if (before[keys[i]] !== after[keys[i]]) return true;
    }
    return false;
  }

  var language = "en";
  function refreshLanguage() {
    try {
      if (root.iCUE && root.iCUE.iCUELanguage) language = String(root.iCUE.iCUELanguage);
    } catch (error) {}
    return language;
  }

  /** tr() returns a Promise and only exists inside iCUE; fall back to the key itself. */
  function translate(key) {
    try {
      if (typeof root.tr === "function") {
        return Promise.resolve(root.tr(key)).then(function (value) {
          return value == null || value === "" ? key : String(value);
        }, function () { return key; });
      }
    } catch (error) {}
    return Promise.resolve(key);
  }

  /** Translate every [data-i18n] element in one pass. */
  function translateDom(scope) {
    var nodes = (scope || document).querySelectorAll("[data-i18n]");
    var list = Array.prototype.slice.call(nodes);
    return Promise.all(list.map(function (node) {
      return translate(node.getAttribute("data-i18n")).then(function (text) {
        node.textContent = text;
      });
    }));
  }

  /**
   * The Edge dashboard places widgets into fixed slots. Rather than match exact pixel
   * sizes, classify by width and orientation so unknown sizes still land somewhere sane.
   * Known Edge slots: 840x344, 696x416, 840x696, 696x840, 1688x696, 696x1688, 2536x696.
   */
  function slot() {
    var w = root.innerWidth || document.documentElement.clientWidth || 840;
    var h = root.innerHeight || document.documentElement.clientHeight || 344;
    var orientation = w >= h ? "h" : "v";
    var span = orientation === "h" ? w : h;
    var size = span >= 2000 ? "xl" : span >= 1300 ? "l" : span >= 620 ? "m" : "s";
    if (orientation === "h" && h <= 380) size = span >= 1300 ? "l" : "s";
    return size + "-" + orientation;
  }

  /** localStorage namespaced to this widget instance, so two copies never collide. */
  function storageKey(name) {
    var id = "widget";
    try {
      if (typeof root.uniqueId !== "undefined" && root.uniqueId) id = String(root.uniqueId);
    } catch (error) {}
    return id + ":" + name;
  }

  function storageGet(name, fallback) {
    try {
      var raw = localStorage.getItem(storageKey(name));
      return raw == null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function storageSet(name, value) {
    try {
      localStorage.setItem(storageKey(name), JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Wire up the lifecycle. Call once, at the bottom of your app script.
   *   onReady   runs exactly once, when the host is initialized (or immediately outside iCUE)
   *   onUpdate  runs on every settings change; receives (current, previous) snapshots
   */
  function start(handlers) {
    var booted = false;
    var last = null;

    function ready() {
      if (booted) return;
      booted = true;
      refreshLanguage();
      last = snapshot();
      try { handlers.onReady && handlers.onReady(last); } catch (error) { console.error(error); }
    }

    function update() {
      if (!booted) { ready(); return; }
      var previous = last;
      var current = snapshot();
      last = current;
      try { handlers.onUpdate && handlers.onUpdate(current, previous); } catch (error) { console.error(error); }
    }

    try {
      root.icueEvents = { onICUEInitialized: ready, onDataUpdated: update };
    } catch (error) {}

    root.addEventListener("resize", function () {
      try { handlers.onResize && handlers.onResize(slot()); } catch (error) { console.error(error); }
    });

    function maybeReady() {
      var initialized = false;
      try { initialized = typeof root.iCUE_initialized !== "undefined" && !!root.iCUE_initialized; } catch (error) {}
      // Outside iCUE (plain browser preview) nothing will ever initialize us, so boot anyway.
      if (initialized || !insideICUE) ready();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", maybeReady);
    } else {
      maybeReady();
    }
  }

  root.ICUE = {
    insideICUE: insideICUE,
    propertyNames: PROPERTY_NAMES.slice(),
    declaredDefaults: DECLARED_DEFAULTS,
    prop: prop,
    string: propString,
    number: propNumber,
    bool: propBool,
    snapshot: snapshot,
    changed: changed,
    get language() { return language; },
    translate: translate,
    translateDom: translateDom,
    slot: slot,
    storageGet: storageGet,
    storageSet: storageSet,
    start: start
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
