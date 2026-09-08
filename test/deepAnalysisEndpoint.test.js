const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app } = require("../server");
const GenreAdvisory = require("../js/semantic/genreAdvisory");

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
    assert.equal(options.headers["X-Music-Shower-Genre-Advisory"], undefined,
      "word-pool listening must remain blind even when an obsolete client sends an advisory");
    return { ok: true, json: async () => ({
      caption: "A warm, repetitive synth loop with a steady groove. 1990년대 영국 클럽의 향수가 느껴진다.",
      structuredPacket: {
        signatureRelations: [{ id: "s1", text: "bass answers clipped vocal", supportRefs: ["f1"], confidence: 0.65 }]
      },
      continuity: { sessionId: "17", segmentId: "4", activeAudioMs: 75200, priorSegments: 0,
        listeningMode: "independent", independent: true,
        genreAdvisoryUsed: false, genreAdvisoryCandidates: [] }
    }) };
  };
  try {
    await withServer(async port => {
      const { status, body } = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Session": "17",
        "X-Music-Shower-Segment": "4",
        "X-Music-Shower-Active-Ms": "75200",
        "X-Music-Shower-Genre-Advisory": GenreAdvisory.encode({ candidates: [
          { label: "City Pop", score: 0.4 }, { label: "Nu Disco", score: 0.3 }
        ], uncertainty: {
          uncertain: false, semanticConfidence: 0.58, margin: 0.07, entropy: 0.81
        } })
      });
      assert.equal(status, 200);
      assert.equal(body.sessionId, "17");
      assert.equal(body.segmentId, "4");
      assert.equal(body.activeAudioMs, 75200);
      assert.equal(body.continuity.priorSegments, 0);
      assert.equal(body.continuity.genreAdvisoryUsed, false);
      // The review report is still returned in full, for transparency -- but no longer as a
      // separate approval gate blocking the observations below.
      assert.ok(Array.isArray(body.claims));
      assert.ok(Array.isArray(body.observations) && body.observations.length > 0,
        "a caption with real matched keywords must produce real candidate observations");
      for (const observation of body.observations) {
        assert.equal(observation.source, "directAudio");
        assert.ok(observation.confidence <= 0.70,
          "a single structured model observation must remain below measured-signal certainty");
      }
      assert.ok(!body.observations.some(item => item.category === "genre"));
      assert.ok(body.observations.some(item => item.evidenceType === "signatureRelation"));
    });
  } finally { global.fetch = originalFetch; }
});

test("segment one is forced blind even when a client sends a reliable advisory", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, "http://localhost:5005/analyze");
    assert.equal(options.headers["X-Music-Shower-Segment"], "1");
    assert.equal(options.headers["X-Music-Shower-Genre-Advisory"], undefined);
    return { ok: true, json: async () => ({ caption: "", structuredPacket: {}, continuity: {
      segmentId: "1", genreAdvisoryUsed: false, genreAdvisoryCandidates: []
    } }) };
  };
  try {
    await withServer(async port => {
      const advisory = GenreAdvisory.encode({
        candidates: [{ label: "Jazz", score: 0.2 }],
        uncertainty: { uncertain: false, semanticConfidence: 0.7, margin: 0.08, entropy: 0.6 }
      });
      const { status } = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Segment": "1", "X-Music-Shower-Genre-Advisory": advisory
      });
      assert.equal(status, 200);
    });
  } finally { global.fetch = originalFetch; }
});

test("odd verification segments stay blind even when an obsolete client sends an advisory", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, "http://localhost:5005/analyze");
    assert.equal(options.headers["X-Music-Shower-Segment"], "3");
    assert.equal(options.headers["X-Music-Shower-Genre-Advisory"], undefined);
    return { ok: true, json: async () => ({ caption: "", structuredPacket: {}, continuity: {
      segmentId: "3", listeningMode: "independent", genreAdvisoryUsed: false, genreAdvisoryCandidates: []
    } }) };
  };
  try {
    await withServer(async port => {
      const advisory = GenreAdvisory.encode({
        candidates: [{ label: "Electronic", score: 0.8 }],
        uncertainty: { uncertain: false, semanticConfidence: 0.8, margin: 0.08, entropy: 0.5 }
      });
      const { status } = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Segment": "3", "X-Music-Shower-Genre-Advisory": advisory
      });
      assert.equal(status, 200);
    });
  } finally { global.fetch = originalFetch; }
});

test("a superseded Flamingo request is diagnosed as cancellation, not a server failure", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  const errors = [], logs = [];
  let analyzeCalls = 0;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  global.fetch = async (url, options = {}) => {
    if (url === "http://localhost:5005/cancel") return { ok: true };
    assert.equal(url, "http://localhost:5005/analyze");
    analyzeCalls += 1;
    if (analyzeCalls === 1) {
      markFirstStarted();
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true }));
    }
    return { ok: true, json: async () => ({ caption: "", structuredPacket: {} }) };
  };
  console.error = (...args) => errors.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withServer(async port => {
      const first = post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Request-Id": "first-request"
      });
      await firstStarted;
      const second = await post(port, "/api/deep-analysis", Buffer.from("RIFF....WAVEfmt "), "audio/wav", {
        "X-Music-Shower-Request-Id": "second-request"
      });
      const cancelled = await first;
      assert.equal(second.status, 200);
      assert.equal(cancelled.status, 409);
      assert.equal(cancelled.body.reason, "superseded");
      assert.ok(logs.some(line => line.includes("[deep-analysis cancelled]") && line.includes("reason=superseded")));
      assert.ok(!errors.some(line => line.includes("[deep-analysis error]")));
    });
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
});
