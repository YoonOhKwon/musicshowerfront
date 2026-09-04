// Section 19: every detector added in this pass gets a positive, a negative and a borderline
// input. The generators are the same ones the scenario fixtures use, so a detector cannot pass
// here on hand-tuned input and then behave differently in the language pipeline.
const test = require("node:test");
const assert = require("node:assert/strict");

const HarmonicMotion = require("../js/mir/harmonicMotionEngine");
const MelodyContour = require("../js/mir/melodyContourEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const lexicon = require("../data/musicalLexicon.json");
const { harmonicMotionFrom, pitchEvidenceFrom } = require("./fixtures/languageProfiles");

const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema() });
const noContext = { primary: "Unknown", confidence: 0.1, uncertain: true };

// Runs the real primitive stage over detector output, then asks the knowledge layer what it would
// say. This is the whole chain section 8 cares about: detector -> primitive -> idiom.
function idiomsFor({ harmony = null, melody = null } = {}) {
  const value = Primitives.analyze({ harmonicMotion: harmony, pitchEvidence: melody });
  return { value, texts: engine.evaluate(value, noContext).map(item => item.text) };
}

function random(seed) {
  let state = seed;
  return () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}
// Every pitch class active at a random level: a smear with no pitch focus at all.
const noiseFrames = (count, seed = 7) => {
  const next = random(seed);
  return Array.from({ length: count }, () => Array.from({ length: 12 }, () => 0.2 + next() * 0.8));
};
// Three random pitch classes per frame: harmony that moves, but to nowhere in particular.
const randomChordFrames = (count, seed = 11) => {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const frame = Array.from({ length: 12 }, () => 0.03);
    for (let tone = 0; tone < 3; tone++) frame[Math.floor(next() * 12)] = 0.9;
    return frame;
  });
};

test("harmonic rhythm separates slow, rapid and unstable harmony", () => {
  const slow = harmonicMotionFrom({ progression: [[0, "maj7"], [7, "maj"]], framesPerChord: 30, repeats: 3, tonalFocus: 0.7 });
  const rapid = harmonicMotionFrom({ progression: [[0, "maj"], [5, "min7"], [7, "maj"], [9, "min7"], [2, "min7"], [4, "min7"]],
    framesPerChord: 4, repeats: 5, tonalFocus: 0.6 });
  const noisy = HarmonicMotion.analyze({ chromaFrames: noiseFrames(60), frameIntervalMs: 100, bpm: 120, tonalFocus: 0.2 });

  assert.equal(slow.reason, "measured");
  assert.ok(slow.chordChangeRate < 0.3, `slow chordChangeRate=${slow.chordChangeRate}`);
  assert.ok(slow.harmonicStability > 0.8, `slow harmonicStability=${slow.harmonicStability}`);
  assert.ok(rapid.chordChangeRate > 0.7, `rapid chordChangeRate=${rapid.chordChangeRate}`);
  assert.ok(rapid.harmonicStability < slow.harmonicStability);
  // Borderline: a pitch smear is measurable but must not read as a repeating progression, and its
  // confidence must drop because nothing tonal is holding still.
  assert.ok(noisy.harmonicRepetition < 0.3, `noise harmonicRepetition=${noisy.harmonicRepetition}`);
  assert.ok(noisy.confidence < slow.confidence);
  // Negative: harmony that changes constantly and lands nowhere is the unstable case, and it must
  // not be mistaken for rapid-but-purposeful movement.
  const unstable = HarmonicMotion.analyze({ chromaFrames: randomChordFrames(60), frameIntervalMs: 100, bpm: 120, tonalFocus: 0.35 });
  assert.ok(unstable.harmonicStability < 0.2, `unstable harmonicStability=${unstable.harmonicStability}`);
  assert.ok(unstable.harmonicRepetition < rapid.harmonicRepetition);
  assert.equal(unstable.modality, null, "random chords must not produce a mode claim");
});

test("a chroma window too short or too atonal to read reports why instead of guessing", () => {
  assert.equal(HarmonicMotion.analyze({ chromaFrames: noiseFrames(6) }).reason, "insufficient-frames");
  assert.equal(HarmonicMotion.analyze({ chromaFrames: noiseFrames(40), tonalFocus: 0.02 }).reason, "untonal-signal");
  for (const value of Object.values(HarmonicMotion.analyze({ chromaFrames: [] })))
    assert.ok(value === null || typeof value === "string" || typeof value === "number" || typeof value === "object");
});

test("major, minor and modal tendencies stay conservative (section 4-2)", () => {
  const major = harmonicMotionFrom({ progression: [[0, "maj"], [5, "maj"], [7, "maj"], [0, "maj"]], framesPerChord: 12, repeats: 3, tonalFocus: 0.75 });
  const minor = harmonicMotionFrom({ progression: [[9, "min"], [2, "min"], [4, "min"], [9, "min"]], framesPerChord: 12, repeats: 3, tonalFocus: 0.75 });
  // G mixolydian: the flat seventh (F major) is what makes this modal rather than plain G major.
  const modal = harmonicMotionFrom({ progression: [[7, "maj"], [5, "maj"], [7, "maj"], [0, "maj"]], framesPerChord: 12, repeats: 3, tonalFocus: 0.75 });

  assert.equal(major.modality, "major");
  assert.equal(minor.modality, "minor");
  assert.equal(modal.modality, "modal");
  // Plain diatonic harmony must not be dressed up as modal colour.
  assert.ok(major.majorMinorDeviation < 0.1, `major deviation=${major.majorMinorDeviation}`);
  assert.ok(minor.majorMinorDeviation < 0.1, `minor deviation=${minor.majorMinorDeviation}`);
  assert.ok(modal.majorMinorDeviation > 0.3, `modal deviation=${modal.majorMinorDeviation}`);
  assert.ok(modal.modalLikelihood > 0.6);
  // A single chord is a chord, not a scale: no mode may be named from it.
  const oneChord = harmonicMotionFrom({ progression: [[0, "maj7"]], framesPerChord: 40, repeats: 1, tonalFocus: 0.8 });
  assert.equal(oneChord.modality, null, "a lone chord must not produce a mode claim");
  assert.ok(oneChord.pitchClassCount <= 5);
});

test("modality reaches the knowledge layer as a tendency phrase, never a mode name", () => {
  const modal = harmonicMotionFrom({ progression: [[7, "maj"], [5, "maj"], [7, "maj"], [0, "maj"]], framesPerChord: 12, repeats: 3, tonalFocus: 0.75 });
  const major = harmonicMotionFrom({ progression: [[0, "maj"], [5, "maj"], [7, "maj"], [0, "maj"]], framesPerChord: 12, repeats: 3, tonalFocus: 0.75 });
  const modalTexts = idiomsFor({ harmony: modal }).texts;
  const majorTexts = idiomsFor({ harmony: major }).texts;
  assert.ok(modalTexts.includes("모달 하모니"), `modal harmony should surface: ${modalTexts.join(", ")}`);
  assert.ok(!majorTexts.includes("모달 하모니"), `plain major must not: ${majorTexts.join(", ")}`);
  assert.ok(majorTexts.includes("장조 성향"), majorTexts.join(", "));
  // Specific mode names are never asserted from a folded chroma vector.
  for (const text of [...modalTexts, ...majorTexts])
    assert.ok(!/도리안|믹솔리디안|리디안|프리지안|Dorian|Mixolydian/i.test(text), `mode name leaked: ${text}`);
});

test("melodic contour separates ascent, descent, arch, wave and a fixed cell", () => {
  const rising = Array.from({ length: 14 }, (_, index) => [index, 3]);
  const ascending = pitchEvidenceFrom({ notes: rising, clarity: 0.4, phraseAfter: [6, 13] });
  const descending = pitchEvidenceFrom({ notes: [...rising].reverse(), clarity: 0.4, phraseAfter: [6, 13] });
  const arch = pitchEvidenceFrom({ notes: [[0, 3], [3, 3], [7, 3], [11, 3], [14, 3], [11, 3], [7, 3], [3, 3], [0, 3]],
    clarity: 0.4, phraseAfter: [4, 8] });
  const cell = pitchEvidenceFrom({ notes: [[7, 3], [7, 3], [8, 3], [7, 3], [7, 3], [8, 3], [7, 3], [7, 3], [8, 3], [7, 3], [7, 3], [8, 3]],
    clarity: 0.4, phraseAfter: [2, 5, 8, 11] });

  assert.equal(ascending.melodicContour, "ascending");
  assert.equal(descending.melodicContour, "descending");
  assert.equal(arch.melodicContour, "arched");
  assert.equal(cell.melodicContour, "static");
  // contourSlope is the signed version of the same measurement and must agree with the label.
  assert.ok(ascending.contourSlope > 0.25 && descending.contourSlope < -0.25);
  assert.ok(Math.abs(arch.contourSlope) < 0.15, `an arch returns where it started: ${arch.contourSlope}`);
  // Borderline: a line with almost no span is static, not a direction, whatever its endpoints do.
  const flat = pitchEvidenceFrom({ notes: Array.from({ length: 14 }, (_, index) => [7 + (index % 2 ? 1 : 0), 3]),
    clarity: 0.4, phraseAfter: [6, 13] });
  assert.equal(flat.melodicContour, "static");
  assert.ok(flat.melodicRange < 0.1);
});

test("step versus leap is read from interval sizes, not from note names", () => {
  const stepwise = pitchEvidenceFrom({ notes: Array.from({ length: 14 }, (_, index) => [index % 8, 3]), clarity: 0.4, phraseAfter: [6, 13] });
  const leaping = pitchEvidenceFrom({ notes: [[0, 3], [12, 3], [2, 3], [14, 3], [4, 3], [16, 3], [3, 3], [15, 3], [1, 3], [13, 3]],
    clarity: 0.4, phraseAfter: [4, 9] });
  assert.ok(stepwise.stepwiseMotion > 0.8, `stepwise=${stepwise.stepwiseMotion}`);
  assert.ok(stepwise.leapLikelihood < 0.2, `stepwise leap=${stepwise.leapLikelihood}`);
  assert.ok(leaping.leapLikelihood > 0.8, `leaping=${leaping.leapLikelihood}`);
  assert.ok(leaping.melodicRange > stepwise.melodicRange);
  // Borderline: a sustained line has no moving intervals to judge, so both stay null.
  const sustained = pitchEvidenceFrom({ notes: [[7, 40]], clarity: 0.4 });
  assert.equal(sustained.stepwiseMotion, null);
  assert.equal(sustained.leapLikelihood, null);
});

test("motif recurrence rises for a repeating cell and stays low for a wandering line", () => {
  const repeating = pitchEvidenceFrom({ notes: [[0, 3], [4, 3], [7, 3], [4, 3], [0, 3], [4, 3], [7, 3], [4, 3], [0, 3], [4, 3], [7, 3], [4, 3]],
    clarity: 0.4, phraseAfter: [3, 7, 11] });
  const wandering = pitchEvidenceFrom({ notes: [[0, 3], [5, 3], [3, 3], [11, 3], [6, 3], [1, 3], [9, 3], [4, 3], [14, 3], [2, 3], [8, 3], [12, 3]],
    clarity: 0.4, phraseAfter: [5, 11] });
  assert.ok(repeating.motifRecurrence > 0.6, `repeating motif=${repeating.motifRecurrence}`);
  assert.ok(wandering.motifRecurrence < 0.5, `wandering motif=${wandering.motifRecurrence}`);
  assert.ok(repeating.melodicRepetition > wandering.melodicRepetition);
  // A plain rising scale repeats "step up" forever; calling that a melodic sequence would be a
  // true statement about nothing, so it must not qualify.
  const scale = pitchEvidenceFrom({ notes: Array.from({ length: 16 }, (_, index) => [index, 3]), clarity: 0.4, phraseAfter: [7, 15] });
  assert.ok((scale.sequenceLikelihood ?? 0) < 0.3, `a scale is not a sequence: ${scale.sequenceLikelihood}`);
});

test("phrases and response form come from timing, not from genre (sections 6)", () => {
  // Four phrases alternating high and low register, each closed by a real rest.
  const alternating = pitchEvidenceFrom({
    notes: [[12, 3], [14, 3], [12, 3], [0, 3], [2, 3], [0, 3], [12, 3], [14, 3], [12, 3], [0, 3], [2, 3], [0, 3]],
    clarity: 0.4, phraseAfter: [2, 5, 8, 11] });
  const single = pitchEvidenceFrom({ notes: Array.from({ length: 16 }, (_, index) => [index % 6, 3]), clarity: 0.4 });
  assert.equal(alternating.phraseCount, 4);
  assert.ok(alternating.callResponseLikelihood > 0.5, `alternation=${alternating.callResponseLikelihood}`);
  assert.ok(alternating.phraseRegularity > 0.6, `regularity=${alternating.phraseRegularity}`);
  // One unbroken line has nothing to answer, and needs at least four phrases before the measure
  // is even attempted.
  assert.equal(single.phraseCount, 1);
  assert.equal(single.callResponseLikelihood, null);
});

test("melody detectors reach the knowledge layer and only speak when measured", () => {
  const ascending = pitchEvidenceFrom({ notes: Array.from({ length: 14 }, (_, index) => [index, 3]), clarity: 0.4, phraseAfter: [6, 13] });
  const descending = pitchEvidenceFrom({ notes: Array.from({ length: 14 }, (_, index) => [13 - index, 3]), clarity: 0.4, phraseAfter: [6, 13] });
  const up = idiomsFor({ melody: ascending });
  const down = idiomsFor({ melody: descending });
  assert.equal(up.value.melody.melodicContour, "ascending");
  assert.ok(up.texts.includes("상행 선율"), up.texts.join(", "));
  assert.ok(down.texts.includes("하행 선율"), down.texts.join(", "));
  assert.ok(!up.texts.includes("하행 선율"));
  // With no pitch evidence at all, every melody primitive stays null and no melodic idiom fires.
  const silent = idiomsFor({});
  for (const value of Object.values(silent.value.melody)) assert.equal(value, null);
  assert.ok(!silent.texts.some(text => /선율|프레이즈|모티프|모티브/.test(text)), silent.texts.join(", "));
});

test("harmony and melody primitives carry detector provenance, not a borrowed number", () => {
  const harmony = harmonicMotionFrom({ progression: [[0, "maj7"], [9, "min7"], [2, "min7"], [7, "maj"]],
    framesPerChord: 10, repeats: 3, tonalFocus: 0.7 });
  const melody = pitchEvidenceFrom({ notes: Array.from({ length: 14 }, (_, index) => [index, 3]), clarity: 0.4, phraseAfter: [6, 13] });
  const { value } = idiomsFor({ harmony, melody });
  for (const path of ["harmony.chordChangeRate", "harmony.harmonicStability", "harmony.modality",
    "melody.melodicContour", "melody.contourSlope", "melody.melodicDensity", "tonal.pitchSetBreadth"]) {
    const meta = value.meta[path];
    assert.ok(meta?.available, `${path} must be registered as available`);
    assert.ok(meta.anchors.some(anchor => /harmonicMotion|pitchEvidence/.test(anchor)),
      `${path} must credit the detector that measured it: ${JSON.stringify(meta.anchors)}`);
  }
  // Pitch-class breadth is counted over the whole window by the detector rather than guessed.
  assert.equal(value.tonal.pitchSetBreadth, harmony.pitchClassCount);
});
