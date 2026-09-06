const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../scripts/flamingo_server.py"), "utf8");

test("Flamingo prompt declares what every outgoing packet field means", () => {
  for (const field of ["audibleObservations", "genreHypotheses", "contextHypotheses",
    "aestheticConcepts", "impressions", "uncertainties"]) {
    assert.match(source, new RegExp(`WHAT YOU SEND TO MUSIC SHOWER[\\s\\S]+${field}`));
  }
  assert.match(source, /label MUST contain only a compact established or emerging genre/);
  assert.match(source, /Vocabulary is open/);
  assert.match(source, /up to the latest\s*\n?30 seconds/);
});

test("Flamingo terminal prints both raw and sanitized bounded output", () => {
  assert.match(source, /RAW MODEL RESPONSE \(max 6000 chars\)/);
  assert.match(source, /SANITIZED PACKET SENT TO MUSIC SHOWER \(max 6000 chars\)/);
  assert.match(source, /str\(raw_text or ""\)\[:6000\]/);
  assert.match(source, /json\.dumps\(packet, ensure_ascii=False, indent=2\)\[:6000\]/);
});
