const test = require("node:test");
const assert = require("node:assert/strict");
const SessionGuard = require("../js/core/sessionGuard");

test("stale inference results from a previous song are rejected", () => {
  const guard = new SessionGuard();
  const songA = guard.next();
  const songB = guard.next();
  assert.equal(guard.isCurrent(songA), false);
  assert.equal(guard.isCurrent(songB), true);
});
