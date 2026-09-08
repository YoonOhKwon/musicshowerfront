const test = require("node:test");
const assert = require("node:assert/strict");
const Lifecycle = require("../js/semantic/trackLifecycleEngine");
const FacetManager = require("../js/semantic/semanticFacetManager");
const PhraseSelection = require("../js/visual/phraseSelection");

// ---------------------------------------------------------------------------------------------
// Streaming-service track boundaries live in the GAP between songs, not in the audio either side
// of it. Two consecutive tracks can share tempo, key and production closely enough that no
// feature comparison separates them -- but almost nothing puts a second of digital silence in
// the middle of a track. These replay that shape at the real 500ms tick cadence with jittered
// features, since noiseless constants are what let the previous thresholds look correct.
// ---------------------------------------------------------------------------------------------
const SONG_A = { bpm: 128, chroma: [.9, .1, .05, .7, .15, .05, .8, .1, .05, .6, .1, .05],
  mfcc: [22, 9, 4.5, 2.8, 1.9, .8, -1.1, -2.2, -3.1], bands: [.58, .30, .12],
  centroid: 1650, flatness: .10, rms: .09 };
// A different track beatmatched to the same tempo AND played in the same key: only the
// instrument palette separates it. This is the transition that used to go unnoticed.
const SONG_B_CLOSE = { ...SONG_A, mfcc: [19, -5, 8, -6, 6.5, -3.5, 4.2, -2.4, 5.1],
  bands: [.16, .33, .51], centroid: 2750, flatness: .28, rms: .075 };

function replay(script) {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const jitter = (value, pct) => value * (1 + (rnd() - 0.5) * 2 * pct);
  const noisy = (f) => ({ bpm: jitter(f.bpm, .015), bpmConfidence: .85,
    chroma: f.chroma.map((v) => Math.max(0, jitter(v + .02, .18))),
    mfcc: f.mfcc.map((v) => v + (rnd() - .5) * 1.2),
    bands: f.bands.map((v) => Math.max(0, jitter(v, .06))),
    centroid: jitter(f.centroid, .05), flatness: jitter(f.flatness, .10),
    rms: jitter(f.rms, .08), spectralNovelty: jitter(.18, .4) });

  const lifecycle = new Lifecycle.LifecycleEngine();
  let resets = 0;
  lifecycle.onResetTrack = () => { resets += 1; };
  let now = 1000;
  for (const step of script) {
    if (step.silentMs !== undefined) {
      const end = now + step.silentMs;
      while (now < end) { lifecycle.tick({ isAudible: false, now }); now += 250; }
    } else {
      for (let i = 0; i < step.sec * 2; i++) {
        lifecycle.tick({ isAudible: true, now, features: noisy(step.f) });
        now += 500;
      }
    }
  }
  return resets;
}

test("a gap into a DIFFERENT song is a track change even when tempo and key are identical", () => {
  assert.equal(replay([{ sec: 60, f: SONG_A }, { silentMs: 1200 }, { sec: 25, f: SONG_B_CLOSE }]), 1);
});

test("a gap as short as half a second still partitions two songs", () => {
  assert.equal(replay([{ sec: 60, f: SONG_A }, { silentMs: 500 }, { sec: 25, f: SONG_B_CLOSE }]), 1,
    "inter-track gaps on a streaming service are often well under a second");
});

test("the same gap around the SAME song is a pause, not a boundary", () => {
  assert.equal(replay([{ sec: 60, f: SONG_A }, { silentMs: 800 }, { sec: 25, f: SONG_A }]), 0);
  assert.equal(replay([{ sec: 60, f: SONG_A }, { silentMs: 4000 }, { sec: 25, f: SONG_A }]), 0,
    "a longer pause is still a pause as long as the song proves it is the same one");
});

test("a buffering dropout mid-song does not end the track", () => {
  assert.equal(replay([{ sec: 60, f: SONG_A }, { silentMs: 500 }, { sec: 25, f: SONG_A }]), 0);
});

test("a gap before the signature matures is judged on the audio either side of it", () => {
  assert.equal(replay([{ sec: 10, f: SONG_A }, { silentMs: 1000 }, { sec: 20, f: SONG_A }]), 0,
    "nothing moved across the gap, so the same song is resuming");
  assert.equal(replay([{ sec: 10, f: SONG_A }, { silentMs: 1000 }, { sec: 20, f: SONG_B_CLOSE }]), 1);
});

test("a gapless transition is still caught, so the gap rule is an addition and not a crutch", () => {
  assert.equal(replay([{ sec: 60, f: SONG_A }, { sec: 25, f: SONG_B_CLOSE }]), 1);
});

// ---------------------------------------------------------------------------------------------
// Deep-listen concepts were losing on COUNT, not on merit: the local composers emit dozens of
// phrases per tick, the facet cursors in curate() walk in score order, and the reservoir
// published its volatility decay in the same `score` field the critic uses for quality -- so
// Flamingo output sank below every local phrase within a minute and was crowded out entirely.
// ---------------------------------------------------------------------------------------------
const flamingoConcept = (text, i) => ({ text, category: i % 2 ? "association" : "mood",
  layer: i % 2 ? "AESTHETIC" : "IMPRESSION", confidence: 0.6, score: 0.6, evidenceScore: 0.6,
  weight: 0.6, source: "directAudio", sourceFamily: "directAudio",
  reservoirScore: 0.3, freshness: 0.3, anchors: ["directAudioEvidence.concepts"] });

const localPhrase = (i) => ({ text: "로컬 표현 " + i, category: ["rhythm", "production",
  "instrumentation", "mood", "association", "genre", "dynamics", "arrangement"][i % 8],
  layer: ["LIVE", "FACT", "FACT", "CONTEXT", "AESTHETIC", "IMPRESSION"][i % 6],
  confidence: 0.85, score: 0.88 - (i % 20) * 0.005, evidenceScore: 0.8,
  source: ["idiom", "live-event", "fact-composition", "rhythm"][i % 4],
  anchors: ["measurements.bpm"] });

test("a crowd of local phrases cannot squeeze every deep-listen concept out of the curated set", () => {
  const flamingo = ["미니멀한 전자음", "초연한 디지털", "비에 젖은 네온", "기계적인 반복",
    "동시대 디지털 씬", "절제된 질감", "차가운 잔향", "무표정한 그루브"].map(flamingoConcept);
  for (const localCount of [60, 120, 160]) {
    const pool = [...Array.from({ length: localCount }, (_, i) => localPhrase(i)), ...flamingo];
    const curated = FacetManager.curate(pool, 40);
    const kept = curated.filter((item) => item.source === "directAudio").length;
    assert.equal(kept, flamingo.length,
      localCount + " local phrases must still leave room for all " + flamingo.length +
      " direct-audio concepts, kept " + kept);
  }
});

test("the reservation is a ceiling, not a quota that invents or over-serves candidates", () => {
  const pool = [...Array.from({ length: 60 }, (_, i) => localPhrase(i)), flamingoConcept("단 하나", 0)];
  const curated = FacetManager.curate(pool, 40);
  assert.equal(curated.filter((item) => item.source === "directAudio").length, 1,
    "one available concept means one reserved slot used, never a padded quota");
});

test("Music Flamingo is priced as a real evidence source, not left in the unlisted default bucket", () => {
  const shape = { text: "테스트 표현", category: "association", layer: "AESTHETIC",
    confidence: 0.65, specificity: 0.8, novelty: 0.72, contrastiveness: 0.55,
    evidenceScore: 0.65, relevance: 0.7, type: "fragment" };
  const direct = PhraseSelection.weight({ ...shape, source: "directAudio" }, []);
  const unlisted = PhraseSelection.weight({ ...shape, source: "unknown-source-xyz" }, []);
  const localComposer = PhraseSelection.weight({ ...shape, source: "production" }, []);
  assert.ok(direct > unlisted * 1.2,
    "a dedicated audio model must not weigh the same as an unknown source: " + direct + " vs " + unlisted);
  assert.ok(direct >= localComposer,
    "it listens to the actual recording; a local production heuristic infers from features");
});
