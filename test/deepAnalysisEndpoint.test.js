const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app } = require("../server");

// Real HTTP round-trip against the actual route (not just the exported pure helpers
// serverRequest.test.js covers), because the point of this test is the WIRING: that
// /api/deep-analysis never reaches OpenAI and never returns display-ready words, only a
// human-review-required report -- see the comment above the route in server.js.
function withServer(run) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await run(server.address().port); resolve(); }
      catch (error) { reject(error); }
      finally { server.close(); }
    });
  });
}

function post(port, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": body.length } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("deep-analysis never calls OpenAI and returns a human-review-required report, not display-ready words", async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    assert.equal(url, "http://localhost:5005/analyze", "must only talk to the local Flamingo server, nothing else");
    return { ok: true, json: async () => ({ caption: "A warm, repetitive synth loop with a steady four-on-the-floor kick." }) };
  };
  try {
    await withServer(async port => {
      const { status, body } = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav");
      assert.equal(status, 200);
      assert.equal(body.status, "human-review-required");
      assert.equal(body.deepWords, undefined, "must never hand back ready-to-display words");
      assert.ok(Array.isArray(body.claims));
      assert.ok(body.claims.every(claim => claim.approved === false && claim.reviewRequired === true));
      assert.ok(body.policy.some(line => /human/i.test(line)));
    });
  } finally { global.fetch = originalFetch; }
});
