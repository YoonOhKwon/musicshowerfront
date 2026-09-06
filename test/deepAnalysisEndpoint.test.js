const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app } = require("../server");

// Real HTTP round-trip against the actual route (not just the exported pure helpers
// serverRequest.test.js covers), because the point of this test is the WIRING: that
// /api/deep-analysis never reaches OpenAI, and returns real candidate-shaped `observations`
// (js/main.js feeds these into applyDirectAudioObservations()) alongside the full review report
// for transparency -- see the comment above the route in server.js.
function withServer(run) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await run(server.address().port); resolve(); }
      catch (error) { reject(error); }
      finally { server.close(); }
    });
  });
}

function post(port, path, body, contentType, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": body.length, ...extraHeaders } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("deep-analysis never calls OpenAI, and returns real candidate observations alongside the review report", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, "http://localhost:5005/analyze", "must only talk to the local Flamingo server, nothing else");
    assert.equal(options.headers["X-Music-Shower-Session"], "17");
    assert.equal(options.headers["X-Music-Shower-Segment"], "4");
    assert.equal(options.headers["X-Music-Shower-Active-Ms"], "75200");
    return { ok: true, json: async () => ({
      caption: "A warm, repetitive synth loop with a steady groove. 1990년대 영국 클럽의 향수가 느껴진다.",
      structuredPacket: {
        genreHypotheses: [{ label: "Lush atmospheric synth pads provide harmonic support", confidence: 0.65 }]
      },
      continuity: { sessionId: "17", segmentId: "4", activeAudioMs: 75200, priorSegments: 2 }
    }) };
  };
  try {
    await withServer(async port => {
      const { status, body } = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Session": "17",
        "X-Music-Shower-Segment": "4",
        "X-Music-Shower-Active-Ms": "75200"
      });
      assert.equal(status, 200);
      assert.equal(body.sessionId, "17");
      assert.equal(body.segmentId, "4");
      assert.equal(body.activeAudioMs, 75200);
      assert.equal(body.continuity.priorSegments, 2);
      // The review report is still returned in full, for transparency -- but no longer as a
      // separate approval gate blocking the observations below.
      assert.ok(Array.isArray(body.claims));
      assert.ok(Array.isArray(body.observations) && body.observations.length > 0,
        "a caption with real matched keywords must produce real candidate observations");
      for (const observation of body.observations) {
        assert.equal(observation.source, "directAudio");
        assert.ok(observation.confidence < 0.65, "a single caption must never reach a measured-signal-level confidence");
      }
      assert.ok(!body.observations.some(item => item.category === "genre"));
      assert.ok(body.observations.some(item => item.category === "production" && item.reclassifiedFrom === "genre"));
    });
  } finally { global.fetch = originalFetch; }
});
