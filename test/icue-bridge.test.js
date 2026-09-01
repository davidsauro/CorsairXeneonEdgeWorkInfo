/*
 * Exercises icue-bridge.js outside iCUE, where it has to stand in for the settings panel.
 * A tiny DOM stub is enough: the bridge only reads the property <meta> tags and
 * location.search.
 */
const { check, done } = require("./harness");

function loadBridge(search, metas) {
  const sandbox = {
    Node: function Node() {},
    Intl: Intl,
    location: { search: search },
    URLSearchParams: URLSearchParams,
    addEventListener: () => {},
    document: {
      readyState: "complete",
      addEventListener: () => {},
      querySelectorAll: (selector) =>
        selector.includes("x-icue-property")
          ? metas.map((m) => ({ getAttribute: (a) => (a === "content" ? m.name : a === "data-default" ? m.def : null) }))
          : []
    }
  };
  sandbox.globalThis = sandbox;

  const vm = require("vm");
  const fs = require("fs");
  const path = require("path");
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/js/icue-bridge.js"), "utf8"), sandbox);
  return sandbox.ICUE;
}

const METAS = [
  { name: "weatherQuery", def: "''" },
  { name: "agendaDays", def: "3" },
  { name: "use24Hour", def: "false" },
  { name: "textColor", def: "'#F1F3F4'" },
  { name: "timeZone", def: "iCUE.defaultTimeZone()" },
  { name: "untyped", def: null }
];

console.log("\ndeclared defaults are used when iCUE has injected nothing");
{
  const ICUE = loadBridge("", METAS);
  check("string default", ICUE.string("textColor", "fallback"), "#F1F3F4");
  check("number default", ICUE.number("agendaDays", 99), 3);
  check("boolean default", ICUE.bool("use24Hour", true), false);
  check("iCUE.defaultTimeZone() is resolved to a real zone",
    typeof ICUE.declaredDefaults.timeZone === "string" && ICUE.declaredDefaults.timeZone.length > 0, true);
  check("caller fallback wins when there is no declared default",
    ICUE.string("untyped", "fallback"), "fallback");
  check("insideICUE is false without tr()", ICUE.insideICUE, false);
}

console.log("\nURL parameters stand in for the settings panel");
{
  const ICUE = loadBridge("?weatherQuery=Boston&agendaDays=5&use24Hour=true", METAS);
  check("string override", ICUE.string("weatherQuery", ""), "Boston");
  check("number override is coerced from text", ICUE.number("agendaDays", 3), 5);
  check("boolean override is coerced from text", ICUE.bool("use24Hour", false), true);
}

console.log("\nZIP codes keep their leading zero");
{
  // Regression: coercing by inspecting the text turned "02110" into 2110, which geocodes
  // to Wijnegem, Belgium instead of Boston.
  const ICUE = loadBridge("?weatherQuery=02110", METAS);
  check("02110 stays a string", ICUE.string("weatherQuery", ""), "02110");
  check("02110 is not a number", typeof ICUE.prop("weatherQuery"), "string");
}
{
  const ICUE = loadBridge("?weatherQuery=00501", METAS);
  check("00501 (lowest US ZIP) survives", ICUE.string("weatherQuery", ""), "00501");
}
{
  const ICUE = loadBridge("?weatherQuery=42.36,-71.06", METAS);
  check("coordinates survive", ICUE.string("weatherQuery", ""), "42.36,-71.06");
}
{
  const ICUE = loadBridge("?agendaDays=notanumber", METAS);
  check("an unparseable number falls back to the declared default",
    ICUE.number("agendaDays", 99), 3);
}
{
  const ICUE = loadBridge("?unknownProperty=x&weatherQuery=Austin", METAS);
  check("an undeclared parameter is ignored", ICUE.string("weatherQuery", ""), "Austin");
}

console.log("\nchange detection");
{
  const ICUE = loadBridge("?weatherQuery=Boston", METAS);
  const before = ICUE.snapshot();
  check("no change against itself", ICUE.changed(before, before, ["weatherQuery"]), false);
  check("change against a different value",
    ICUE.changed({ weatherQuery: "Austin" }, before, ["weatherQuery"]), true);
  check("a missing previous snapshot counts as changed", ICUE.changed(null, before), true);
}

done();
