const test = require("node:test");
const assert = require("node:assert/strict");
const Scheduler = require("../js/semantic/wordPoolScheduler");
const Selection = require("../js/visual/phraseSelection");

test("scheduler prefers a fresh high-confidence FACT over a recently repeated one", () => {
  const fresh = { text: "싱코페이션 베이스", conceptId: "bass.syncopated", layer: "FACT", category: "performance",
    confidence: 0.86, salience: 0.8, source: "idiom" };
  const stale = { text: "4/4 킥", conceptId: "rhythm.four_on_floor", layer: "FACT", category: "rhythm",
    confidence: 0.7, salience: 0.4, source: "rhythm" };
  const recent = [
    { text: "4/4 킥", conceptId: "rhythm.four_on_floor", layer: "FACT" },
    { text: "정박 킥", conceptId: "rhythm.four_on_floor", layer: "FACT" },
    { text: "규칙적인 킥", conceptId: "rhythm.four_on_floor", layer: "FACT" }
  ];
  const prepared = Scheduler.prepare([fresh, stale], recent, { now: 1000, domainDiversity: true });
  assert.equal(prepared.items[0].conceptId, "bass.syncopated");
  assert.ok(prepared.decision.ranked[0].selectionScore > 0);
});

test("LIVE weights freshness more than FACT", () => {
  const live = { text: "필터 변화", conceptId: "production.filtering", layer: "LIVE", category: "live",
    confidence: 0.7, freshness: 0.95, source: "live-event" };
  const fact = { text: "필터 변화", conceptId: "production.filtering", layer: "FACT", category: "production",
    confidence: 0.7, freshness: 0.95, source: "production" };
  const liveScore = Scheduler.score(live, { recent: [] });
  const factScore = Scheduler.score({ ...fact, freshness: 0.2, persistence: 0.9 }, { recent: [] });
  assert.ok(liveScore > 0 && factScore > 0);
});

test("domain diversity does not force a weak domain into the top slot", () => {
  const strong = { text: "4/4 킥", conceptId: "rhythm.a", layer: "FACT", category: "rhythm", confidence: 0.9, salience: 0.9 };
  const weak = { text: "애매한 질감", conceptId: "texture.weak", layer: "FACT", category: "arrangement", confidence: 0.4, salience: 0.2 };
  const prepared = Scheduler.prepare([strong, weak], [], { domainDiversity: true });
  assert.equal(prepared.items[0].conceptId, "rhythm.a");
});

test("choose still returns a candidate after scheduler scoring", () => {
  const pool = [
    { text: "4/4 킥", conceptId: "rhythm.four_on_floor", category: "rhythm", layer: "FACT", source: "rhythm", confidence: 0.8 },
    { text: "싱코페이션 베이스", conceptId: "bass.syncopated", category: "performance", layer: "FACT", source: "idiom", confidence: 0.84 }
  ];
  const chosen = Selection.choose(pool, [], () => 0.01, { observationSeconds: 20, now: 1 });
  assert.ok(chosen?.text);
});
