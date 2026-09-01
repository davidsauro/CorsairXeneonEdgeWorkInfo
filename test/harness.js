/* Minimal assertion helpers, so the tests need no dependencies. */
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name);
    console.log("         expected: " + JSON.stringify(expected));
    console.log("         actual:   " + JSON.stringify(actual));
  }
  return ok;
}

function assert(name, condition, detail) {
  return check(name, !!condition, true) || (detail && console.log("         " + detail), condition);
}

function done() {
  console.log("\n  " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
}

module.exports = { check, assert, done, counts: () => ({ pass, fail }) };
