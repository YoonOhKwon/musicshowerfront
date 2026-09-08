// Controlled descriptor fixtures, not measurements from real songs.
function profile(kind = "cold") {
  if (RICH_KINDS.has(kind)) return buildRichState(kind);
  const warm = kind === "warm";
  const jazz = kind === "jazz";
  return {
    sessionId: 1, semanticEpoch: 1,
    audio: { rms: warm ? 0.025 : 0.22, energy: warm ? 0.08 : 0.48, bass: 0.6, mid: 0.2, high: 0.1 },
    genre: { family: jazz ? "Jazz / Soul" : "Electronic / Club", primary: jazz ? "Hard Bop" : "Techno",
      uncertain: false, confidence: 0.78, fineCandidates: [{ label: jazz ? "Post Bop" : warm ? "Dub Techno" : "Industrial Techno" }] },
    instruments: [], ml: { lastUpdated: 1 },
    novelty: { score: 0.12, transitionDetected: false },
    mood: { fused: { arousal: jazz ? 0.65 : warm ? 0.42 : 0.83, valence: warm ? 0.4 : 0.5, tension: warm ? 0.22 : 0.77, warmth: warm || jazz ? 0.8 : 0.19 } },
    trackCharacter: {
      confidence: 0.9,
      rhythm: { bpm: jazz ? 152 : warm ? 116 : 138, pulseRegularity: jazz ? 0.63 : 0.87, onsetDensity: warm ? 0.3 : 0.8, rhythmicComplexity: jazz ? 0.82 : 0.3, breakbeatLikelihood: jazz ? 0.67 : 0.15 },
      harmony: { tonalness: jazz ? 0.9 : warm ? 0.75 : 0.22, harmonicMotion: jazz ? 0.87 : warm ? 0.55 : 0.12, chromaEntropy: jazz ? 0.23 : warm ? 0.3 : 0.74 },
      timbre: { brightness: jazz ? 0.71 : warm ? 0.38 : 0.77, warmth: jazz ? 0.66 : warm ? 0.88 : 0.19, roughness: jazz ? 0.34 : warm ? 0.17 : 0.88, noisiness: warm ? 0.1 : 0.47, transientSharpness: warm ? 0.14 : 0.82 },
      texture: { density: jazz ? 0.51 : warm ? 0.44 : 0.91, sustainedness: warm ? 0.87 : 0.18, granularness: warm ? 0.16 : 0.75, layeredness: warm ? 0.78 : 0.5 },
      dynamics: { dynamicRange: jazz ? 0.8 : warm ? 0.41 : 0.14, compressionDensity: jazz ? 0.26 : 0.88, pumping: warm ? 0.3 : 0.8 },
      space: { spaciousness: jazz ? 0.54 : warm ? 0.92 : 0.16, perceivedDepth: jazz ? 0.48 : warm ? 0.88 : 0.15 },
      production: { cleanLoFi: jazz ? 0.62 : warm ? 0.83 : 0.35, subWeight: jazz ? 0.24 : warm ? 0.74 : 0.9, saturation: warm ? 0.24 : 0.8, masterBrightness: warm ? 0.38 : 0.77 },
      structure: { repetition: jazz ? 0.4 : 0.88, buildupLikelihood: 0.15, breakdownLikelihood: 0.1, sectionNovelty: 0.12 }
    }
  };
}

// --- Richer, scenario-shaped fixtures -------------------------------------------------------
// Unlike the fixtures above (a handful of trackCharacter fields only), these fill in the
// rhythmicGrammar / productionEvidence / instrumentationEvidence / performance / arrangement
// layers that real evidence-gated CONTEXT/AESTHETIC candidates and edge-specific relations
// actually read. genreContextEvidence and aestheticEvidence are NOT hand-authored: they are
// computed by running the real GenreContext.Engine / AestheticEvidence.Engine against the raw
// fields below, the same way semanticEngine.js derives them in production, so a fixture cannot
// silently drift from what the evidence-gating code actually does.
const GenreContext = require("../../js/semantic/genreContextEngine");
const AestheticEvidence = require("../../js/semantic/aestheticEvidenceEngine");
const AestheticAxisEngine = require("../../js/semantic/aestheticAxisEngine");
const HarmonicMotion = require("../../js/mir/harmonicMotionEngine");
const MelodyContour = require("../../js/mir/melodyContourEngine");
const CandidatePipeline = require("../../js/semantic/semanticCandidatePipeline");
const LanguageComposition = require("../../js/semantic/languageComposition");
const MusicalIdioms = require("../../js/semantic/musicalIdiomEngine");
const genreContextKnowledge = require("../../data/genreContextKnowledge.json");
const musicalLexicon = require("../../data/musicalLexicon.json");
const genreTaxonomy = require("../../data/genreTaxonomy.json");
const aestheticAxes = require("../../data/aestheticAxes.json");
const aestheticAxisEngine = new AestheticAxisEngine.Engine(aestheticAxes);
const genreContextEngine = new GenreContext.Engine(genreContextKnowledge, aestheticAxisEngine);
const aestheticEvidenceEngine = new AestheticEvidence.Engine(aestheticAxisEngine);
const musicalIdiomEngine = new MusicalIdioms.Engine(musicalLexicon,
  { primitiveSchema: require("../../js/semantic/musicalPrimitiveEngine").schema(), genreTaxonomy });

const RICH_KINDS = new Set(["futurefunk", "futurefunkb", "citypop", "citypopb", "ukgarage", "jungle", "techno", "liquiddnb", "funk",
  "jazztrio", "jazzballad", "shoegaze", "ambient", "uncertain"]);

function instrument(label, confidence) { return { label, confidence, source: "ml" }; }

// --- Harmony / melody evidence -------------------------------------------------------------
// Fixtures declare musical intent (a chord loop, a melodic line) and then run the REAL detector
// engines over synthesised chroma frames and pitch trajectories. Nothing below hand-writes a
// detector output, so a fixture can never claim harmonic or melodic evidence that
// harmonicMotionEngine / melodyContourEngine would not actually report for that material.
// Jitter is deterministic so repeated runs and CI agree exactly.
let jitterSeed = 20260905;
function jitter(scale = 0.02) {
  jitterSeed = (Math.imul(jitterSeed, 1103515245) + 12345) & 0x7fffffff;
  return (jitterSeed / 0x7fffffff) * scale;
}

// Semitone offsets from the chord root, as pitch classes; 0 = tonic of the fixture's home key.
const CHORDS = { maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], sus: [0, 5, 7] };

function chromaFrames(progression = [], framesPerChord = 10) {
  const frames = [];
  for (const [root, quality] of progression) {
    const tones = (CHORDS[quality] || CHORDS.maj).map(interval => (root + interval) % 12);
    for (let frame = 0; frame < framesPerChord; frame++) {
      const vector = Array.from({ length: 12 }, () => 0.03 + jitter(0.02));
      for (const tone of tones) vector[tone] = 0.85 + jitter(0.1);
      frames.push(vector);
    }
  }
  return frames;
}

function harmonicMotionFrom({ progression = [], framesPerChord = 10, repeats = 3, bpm = 120, tonalFocus = 0.6 } = {}) {
  const loop = chromaFrames(progression, framesPerChord);
  const frames = [];
  for (let pass = 0; pass < repeats; pass++) frames.push(...loop.map(frame => frame.map(value => value + jitter(0.01))));
  return HarmonicMotion.analyze({ chromaFrames: frames, frameIntervalMs: 100, bpm, tonalFocus });
}

// notes: [semitone, holdFrames] pairs at 40 ms per frame; phraseAfter marks note indices followed
// by a rest long enough to end a phrase.
function pitchTrajectory({ notes = [], clarity = 0.35, phraseAfter = [], frameMs = 40, restMs = 620 } = {}) {
  const samples = [];
  let at = 0;
  notes.forEach(([semitone, hold], index) => {
    for (let frame = 0; frame < hold; frame++) {
      samples.push({ at, semitone: semitone + jitter(0.18), clarity: clarity + jitter(0.05) });
      at += frameMs;
    }
    if (phraseAfter.includes(index)) at += restMs;
  });
  return samples;
}

function pitchEvidenceFrom(spec = {}) {
  return MelodyContour.analyze({ samples: pitchTrajectory(spec), bpm: spec.bpm || 120 });
}

function trackCharacterFrom({ brightness = 0.5, warmth = 0.5, density = 0.5, roughness = 0.3,
  sustain = 0.4, tonalness = 0.4, spaciousness = 0.4, subWeight = 0.5, bpm = 120, pulseRegularity = 0.6 } = {}) {
  return {
    confidence: 0.85,
    rhythm: { bpm, pulseRegularity, onsetDensity: 0.6, rhythmicComplexity: 0.4, breakbeatLikelihood: 0.2 },
    harmony: { tonalness, harmonicMotion: 0.4, chromaEntropy: 1 - tonalness },
    timbre: { brightness, warmth, roughness, noisiness: roughness * 0.5, transientSharpness: 0.5 },
    texture: { density, sustainedness: sustain, granularness: 0.4, layeredness: density },
    dynamics: { dynamicRange: 0.5, compressionDensity: 0.5, pumping: 0.3 },
    space: { spaciousness, perceivedDepth: spaciousness },
    production: { cleanLoFi: 0.5, subWeight, saturation: 0.3, masterBrightness: brightness },
    structure: { repetition: 0.5, buildupLikelihood: 0.2, breakdownLikelihood: 0.15, sectionNovelty: 0.2 }
  };
}

const SCENARIOS = {
  // FACT/CONTEXT/AESTHETIC/IMPRESSION should all have real evidence to draw on.
  futurefunk: () => ({
    genre: { family: "Pop / Internet", primary: "Future Funk", uncertain: false, confidence: 0.88, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.88, swing: 0.15, syncopation: 0.3, brokenBeat: 0.1, confidence: 0.85, onsetCount: 40,
      subdivisionRatio: 1.05, accentPeriodicity: 4, accentPlacement: 0.15, kickPeriodicity: 0.86,
      halfTimeLikelihood: 0.08, doubleTimeLikelihood: 0.1, groovePushPull: 0.05, microTimingDeviation: 0.14, rhythmicEntropy: 0.3 },
    productionEvidence: { sampleBased: 0.8, sidechain: 0.75, filterSweep: 0.55, sourceSeparation: false },
    instruments: [instrument("Synthesizer", 0.75), instrument("Bass", 0.6), instrument("Voice", 0.55)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: 0.7, leadInstrument: "신스", soloInstrument: null },
    arrangement: { density: 0.7, verifiedEnsembleSize: null, dominantRole: "신스" },
    moodDimensions: { brightness: 0.78, warmth: 0.62, valence: 0.72, arousal: 0.7, tension: 0.28, spaciousness: 0.5, weight: 0.5, aggression: 0.2 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.6, bpm: 126, onsetRate: 3.5, transientDensity: 0.6, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.78, warmth: 0.62, density: 0.65, subWeight: 0.6, bpm: 126, pulseRegularity: 0.88 }),
      structure: { repetition: 0.82, buildupLikelihood: 0.2, breakdownLikelihood: 0.15, sectionNovelty: 0.2 } }
  }),
  // A second Future Funk fixture that shares the genre label but earns different evidence:
  // City Pop sample lineage, slower groove, melodic bass, richer harmony — deliberately unlike
  // futurefunk's vocal-chop/bright/strong-sidechain profile (section 33's differentiation test).
  futurefunkb: () => ({
    genre: { family: "Pop / Internet", primary: "Future Funk", uncertain: false, confidence: 0.85, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.5, swing: 0.35, syncopation: 0.45, brokenBeat: 0.12, confidence: 0.8, onsetCount: 32,
      subdivisionRatio: 1.35, accentPeriodicity: 4, accentPlacement: 0.35, kickPeriodicity: 0.5,
      halfTimeLikelihood: 0.2, doubleTimeLikelihood: 0.05, groovePushPull: 0.2, microTimingDeviation: 0.28, rhythmicEntropy: 0.45 },
    productionEvidence: { sampleBased: 0.78, sidechain: 0.2, filterSweep: 0.2, sourceSeparation: false },
    instruments: [instrument("Piano", 0.68), instrument("Electric Guitar", 0.6), instrument("Bass", 0.7)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: 0.5, leadInstrument: "피아노",
      soloInstrument: null, bassFunction: "melodic", bassPitchMotion: 0.72, bassOnsetRegularity: 0.6 },
    arrangement: { density: 0.5, verifiedEnsembleSize: null, dominantRole: "피아노" },
    moodDimensions: { brightness: 0.5, warmth: 0.72, valence: 0.62, arousal: 0.42, tension: 0.2, spaciousness: 0.5, weight: 0.4, aggression: 0.08 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.5, bpm: 100, onsetRate: 2.2, transientDensity: 0.4, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.5, warmth: 0.72, density: 0.45, subWeight: 0.42, bpm: 100, pulseRegularity: 0.65, tonalness: 0.72 }),
      harmony: { tonalness: 0.72, harmonicMotion: 0.35, chromaEntropy: 0.4 } }
  }),
  citypop: () => ({
    genre: { family: "Jazz / Soul", primary: "City Pop", uncertain: false, confidence: 0.82, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.3, swing: 0.4, syncopation: 0.7, brokenBeat: 0.15, confidence: 0.8, onsetCount: 30,
      subdivisionRatio: 1.5, accentPeriodicity: 4, accentPlacement: 0.4, kickPeriodicity: 0.4,
      halfTimeLikelihood: 0.12, doubleTimeLikelihood: 0.08, groovePushPull: 0.16, microTimingDeviation: 0.3, rhythmicEntropy: 0.5 },
    productionEvidence: { sampleBased: null, filterSweep: null, sourceSeparation: false },
    instruments: [instrument("Piano", 0.72), instrument("Bass", 0.65), instrument("Electric Guitar", 0.5)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null, leadInstrument: null, soloInstrument: null },
    arrangement: { density: 0.55, verifiedEnsembleSize: null, dominantRole: "피아노" },
    moodDimensions: { brightness: 0.55, warmth: 0.78, valence: 0.68, arousal: 0.45, tension: 0.2, spaciousness: 0.55, weight: 0.4, aggression: 0.1 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.5, bpm: 108, onsetRate: 2.4, transientDensity: 0.35, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.55, warmth: 0.78, density: 0.5, subWeight: 0.4, bpm: 108, pulseRegularity: 0.7 })
  }),
  // Section 20: a second City Pop that is genuinely a different record -- a slow minor-leaning
  // ballad with brushed drums and electric piano instead of the mid-tempo guitar arrangement. Same
  // genre label, different evidence, so it must not produce the same language.
  citypopb: () => ({
    genre: { family: "Jazz / Soul", primary: "City Pop", uncertain: false, confidence: 0.8, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.1, swing: 0.52, syncopation: 0.3, brokenBeat: 0.08, confidence: 0.7, onsetCount: 18,
      subdivisionRatio: 1.72, accentPeriodicity: 4, accentPlacement: 0.25, kickPeriodicity: 0.3,
      halfTimeLikelihood: 0.42, doubleTimeLikelihood: 0.04, groovePushPull: 0.26, microTimingDeviation: 0.36, rhythmicEntropy: 0.34 },
    productionEvidence: { reverb: 0.68, sampleBased: null, filterSweep: null, sourceSeparation: false },
    instruments: [instrument("Electric Piano", 0.7), instrument("Bass", 0.62), instrument("Voice", 0.58), instrument("Drums", 0.44)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: 0.55, leadInstrument: "보컬",
      soloInstrument: null, bassFunction: "sustained", bassPitchMotion: 0.3, bassOnsetRegularity: 0.7 },
    arrangement: { density: 0.38, verifiedEnsembleSize: null, dominantRole: "보컬" },
    moodDimensions: { brightness: 0.4, warmth: 0.82, valence: 0.42, arousal: 0.28, tension: 0.3, spaciousness: 0.72, weight: 0.36, aggression: 0.05 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.42, bpm: 78, onsetRate: 1.5, transientDensity: 0.22, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.4, warmth: 0.82, density: 0.38, sustain: 0.72, spaciousness: 0.72,
      subWeight: 0.36, bpm: 78, pulseRegularity: 0.62, tonalness: 0.8 }),
      harmony: { tonalness: 0.8, harmonicMotion: 0.22, chromaEntropy: 0.3 } }
  }),
  ukgarage: () => ({
    genre: { family: "Electronic / Club", primary: "UK Garage", uncertain: false, confidence: 0.85, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.2, swing: 0.7, syncopation: 0.6, brokenBeat: 0.75, confidence: 0.85, onsetCount: 35,
      subdivisionRatio: 1.85, accentPeriodicity: 3, accentPlacement: 0.55, kickPeriodicity: 0.3,
      halfTimeLikelihood: 0.15, doubleTimeLikelihood: 0.2, groovePushPull: 0.22, microTimingDeviation: 0.42, rhythmicEntropy: 0.68 },
    productionEvidence: { sampleBased: 0.5, vocalChop: null, sourceSeparation: false },
    instruments: [instrument("Voice", 0.6), instrument("Bass", 0.65), instrument("Drums", 0.55)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null, leadInstrument: null, soloInstrument: null },
    arrangement: { density: 0.6, verifiedEnsembleSize: null, dominantRole: "베이스" },
    moodDimensions: { brightness: 0.6, warmth: 0.4, valence: 0.55, arousal: 0.68, tension: 0.55, spaciousness: 0.4, weight: 0.55, aggression: 0.3 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.55, bpm: 132, onsetRate: 4.2, transientDensity: 0.65, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.6, warmth: 0.4, density: 0.6, subWeight: 0.55, bpm: 132, pulseRegularity: 0.5 })
  }),
  jungle: () => ({
    genre: { family: "Electronic / Club", primary: "Jungle", uncertain: false, confidence: 0.87, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.08, swing: 0.38, syncopation: 0.76, brokenBeat: 0.9, confidence: 0.9, onsetCount: 56,
      subdivisionRatio: 2.1, accentPeriodicity: 5, accentPlacement: 0.6, kickPeriodicity: 0.16,
      halfTimeLikelihood: 0.25, doubleTimeLikelihood: 0.62, groovePushPull: -0.1, microTimingDeviation: 0.58, rhythmicEntropy: 0.82 },
    productionEvidence: { sampleBased: 0.76, sidechain: null, sourceSeparation: false },
    instruments: [instrument("Drums", 0.82), instrument("Bass", 0.78), instrument("Voice", 0.42)],
    performance: { bassFunction: "ostinato", bassPatternRepetition: 0.78, bassSyncopation: 0.72,
      soloLikelihood: null, leadLikelihood: null },
    arrangement: { density: 0.78, verifiedEnsembleSize: null, dominantRole: "드럼" },
    moodDimensions: { brightness: 0.62, warmth: 0.35, valence: 0.5, arousal: 0.9, tension: 0.72, spaciousness: 0.38, weight: 0.82, aggression: 0.62 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.82, bpm: 172, onsetRate: 5.8, transientDensity: 0.9, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.62, warmth: 0.35, density: 0.78, roughness: 0.5, subWeight: 0.82, bpm: 172, pulseRegularity: 0.62 }),
      rhythm: { bpm: 172, pulseRegularity: 0.62, onsetDensity: 0.88, rhythmicComplexity: 0.9, breakbeatLikelihood: 0.92 } }
  }),
  techno: () => ({
    genre: { family: "Electronic / Club", primary: "Techno", uncertain: false, confidence: 0.88,
      secondary: [{ label: "Industrial Techno", confidence: 0.72 }] },
    rhythmicGrammar: { fourOnFloor: 0.94, swing: 0.06, syncopation: 0.22, brokenBeat: 0.08, confidence: 0.92, onsetCount: 44,
      subdivisionRatio: 1.04, accentPeriodicity: 4, accentPlacement: 0.08, kickPeriodicity: 0.92,
      halfTimeLikelihood: 0.04, doubleTimeLikelihood: 0.14, groovePushPull: 0.01, microTimingDeviation: 0.12, rhythmicEntropy: 0.28 },
    productionEvidence: { filterSweep: 0.72, sidechain: 0.71, sourceSeparation: false },
    instruments: [instrument("Drums", 0.84), instrument("Synthesizer", 0.72), instrument("Bass", 0.68)],
    performance: { bassFunction: "ostinato", bassPatternRepetition: 0.86, bassSyncopation: 0.2,
      soloLikelihood: null, leadLikelihood: 0.42, leadInstrument: "신스" },
    arrangement: { density: 0.74, verifiedEnsembleSize: null, dominantRole: "드럼" },
    moodDimensions: { brightness: 0.46, warmth: 0.24, valence: 0.4, arousal: 0.84, tension: 0.7,
      spaciousness: 0.38, weight: 0.78, aggression: 0.58 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.76, bpm: 136, onsetRate: 4.4,
      transientDensity: 0.78, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.46, warmth: 0.24, density: 0.74, roughness: 0.7,
      subWeight: 0.78, bpm: 136, pulseRegularity: 0.92, tonalness: 0.38 }),
      harmony: { tonalness: 0.38, harmonicMotion: 0.08, chromaEntropy: 0.68 },
      dynamics: { dynamicRange: 0.2, compressionDensity: 0.82, pumping: 0.7 },
      production: { cleanLoFi: 0.38, subWeight: 0.78, saturation: 0.76, masterBrightness: 0.46 },
      structure: { repetition: 0.92, buildupLikelihood: 0.48, breakdownLikelihood: 0.12, sectionNovelty: 0.16 } }
  }),
  liquiddnb: () => ({
    genre: { family: "Electronic / Club", primary: "Liquid DnB", uncertain: false, confidence: 0.86, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.08, swing: 0.18, syncopation: 0.58, brokenBeat: 0.84, confidence: 0.88, onsetCount: 52,
      subdivisionRatio: 1.65, accentPeriodicity: 4, accentPlacement: 0.45, kickPeriodicity: 0.34,
      halfTimeLikelihood: 0.52, doubleTimeLikelihood: 0.3, groovePushPull: 0.08, microTimingDeviation: 0.36, rhythmicEntropy: 0.6 },
    productionEvidence: { reverb: 0.78, sourceSeparation: false },
    instruments: [instrument("Drums", 0.76), instrument("Bass", 0.72), instrument("Synth Pad", 0.68), instrument("Voice", 0.45)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null },
    arrangement: { density: 0.68, verifiedEnsembleSize: null, dominantRole: "패드" },
    moodDimensions: { brightness: 0.56, warmth: 0.68, valence: 0.62, arousal: 0.38, tension: 0.28, spaciousness: 0.82, weight: 0.58, aggression: 0.12 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.65, bpm: 174, onsetRate: 5.1, transientDensity: 0.82, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.56, warmth: 0.68, density: 0.68, sustain: 0.72, spaciousness: 0.82, subWeight: 0.62, bpm: 174, pulseRegularity: 0.68 }),
      rhythm: { bpm: 174, pulseRegularity: 0.68, onsetDensity: 0.8, rhythmicComplexity: 0.74, breakbeatLikelihood: 0.86 } }
  }),
  funk: () => ({
    genre: { family: "Jazz / Soul", primary: "Funk", uncertain: false, confidence: 0.86, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.32, swing: 0.66, syncopation: 0.84, brokenBeat: 0.28, confidence: 0.88, onsetCount: 38,
      subdivisionRatio: 1.4, accentPeriodicity: 4, accentPlacement: 0.48, kickPeriodicity: 0.55,
      halfTimeLikelihood: 0.1, doubleTimeLikelihood: 0.15, groovePushPull: 0.26, microTimingDeviation: 0.3, rhythmicEntropy: 0.58 },
    productionEvidence: {},
    instruments: [instrument("Bass", 0.82), instrument("Electric Guitar", 0.7), instrument("Drums", 0.74), instrument("Brass", 0.58)],
    performance: { bassFunction: "melodic", bassPitchMotion: 0.76, bassSyncopation: 0.82,
      bassKickInteraction: 0.8, soloLikelihood: null, leadLikelihood: 0.62 },
    arrangement: { density: 0.62, verifiedEnsembleSize: null, dominantRole: "베이스" },
    moodDimensions: { brightness: 0.62, warmth: 0.74, valence: 0.72, arousal: 0.58, tension: 0.3, spaciousness: 0.35, weight: 0.62, aggression: 0.2 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.7, bpm: 108, onsetRate: 3.8, transientDensity: 0.7, sampleCount: 60 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.62, warmth: 0.74, density: 0.62, subWeight: 0.58, bpm: 108, pulseRegularity: 0.78 }),
      rhythm: { bpm: 108, pulseRegularity: 0.78, onsetDensity: 0.7, rhythmicComplexity: 0.66, breakbeatLikelihood: 0.24 } }
  }),
  // Real performance evidence so walking-bass/solo/trio-adjacent language has something to stand on.
  jazztrio: () => ({
    genre: { family: "Jazz / Soul", primary: "Jazz", uncertain: false, confidence: 0.8,
      secondary: [{ label: "Hard Bop", confidence: 0.72 }] },
    rhythmicGrammar: { fourOnFloor: 0.05, swing: 0.75, syncopation: 0.4, brokenBeat: 0.1, confidence: 0.8, onsetCount: 28,
      subdivisionRatio: 1.92, accentPeriodicity: 3, accentPlacement: 0.5, kickPeriodicity: null,
      halfTimeLikelihood: 0.2, doubleTimeLikelihood: 0.1, groovePushPull: 0.32, microTimingDeviation: 0.34, rhythmicEntropy: 0.62 },
    productionEvidence: {},
    instruments: [instrument("Piano", 0.65), instrument("Bass", 0.7), instrument("Saxophone", 0.75), instrument("Drums", 0.5)],
    performance: { soloLikelihood: 0.85, soloInstrument: "색소폰", walkingBassLikelihood: 0.85,
      bassFunction: "walking", bassPitchMotion: 0.72, bassOnsetRegularity: 0.82,
      leadLikelihood: 0.7, leadInstrument: "색소폰" },
    arrangement: { density: 0.4, verifiedEnsembleSize: null, dominantRole: "색소폰" },
    moodDimensions: { brightness: 0.55, warmth: 0.7, valence: 0.6, arousal: 0.55, tension: 0.3, spaciousness: 0.5, weight: 0.45, aggression: 0.15 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.45, bpm: 168, onsetRate: 2.8, transientDensity: 0.4, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.55, warmth: 0.7, density: 0.45, subWeight: 0.35, bpm: 168, pulseRegularity: 0.55, tonalness: 0.85 })
  }),
  // Section 20: the other side of Jazz -- a verified piano trio playing a ballad, with no horn, no
  // walking bass and a sparse arrangement, against the quartet's up-tempo blowing session.
  jazzballad: () => ({
    genre: { family: "Jazz / Soul", primary: "Jazz", uncertain: false, confidence: 0.78,
      secondary: [{ label: "Modal Jazz", confidence: 0.6 }] },
    rhythmicGrammar: { fourOnFloor: 0.04, swing: 0.58, syncopation: 0.26, brokenBeat: 0.06, confidence: 0.66, onsetCount: 14,
      subdivisionRatio: 1.8, accentPeriodicity: 4, accentPlacement: 0.3, kickPeriodicity: null,
      halfTimeLikelihood: 0.48, doubleTimeLikelihood: 0.04, groovePushPull: 0.3, microTimingDeviation: 0.4, rhythmicEntropy: 0.36 },
    productionEvidence: {},
    instruments: [instrument("Piano", 0.74), instrument("Bass", 0.66), instrument("Drums", 0.48)],
    performance: { soloLikelihood: 0.62, soloInstrument: "피아노", walkingBassLikelihood: null,
      bassFunction: "sustained", bassPitchMotion: 0.34, bassOnsetRegularity: 0.62,
      leadLikelihood: 0.66, leadInstrument: "피아노" },
    arrangement: { density: 0.3, verifiedEnsembleSize: 3, dominantRole: "피아노" },
    moodDimensions: { brightness: 0.44, warmth: 0.72, valence: 0.46, arousal: 0.26, tension: 0.34, spaciousness: 0.68, weight: 0.34, aggression: 0.06 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.4, bpm: 68, onsetRate: 1.3, transientDensity: 0.2, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.44, warmth: 0.72, density: 0.32, sustain: 0.68, spaciousness: 0.68,
      subWeight: 0.34, bpm: 68, pulseRegularity: 0.5, tonalness: 0.86 })
  }),
  shoegaze: () => ({
    genre: { family: "Rock / Metal", primary: "Shoegaze", uncertain: false, confidence: 0.84, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.18, swing: 0.08, syncopation: 0.18, brokenBeat: 0.12, confidence: 0.68, onsetCount: 22,
      subdivisionRatio: 1.1, accentPeriodicity: 4, accentPlacement: 0.2, kickPeriodicity: 0.48,
      halfTimeLikelihood: 0.34, doubleTimeLikelihood: 0.05, groovePushPull: 0.0, microTimingDeviation: 0.2, rhythmicEntropy: 0.28 },
    productionEvidence: { reverb: 0.84, distortion: 0.76, sourceSeparation: false },
    instruments: [instrument("Distorted Guitar", 0.86), instrument("Voice", 0.52), instrument("Bass", 0.58), instrument("Drums", 0.54), instrument("Synth Pad", 0.42)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null },
    arrangement: { density: 0.88, verifiedEnsembleSize: null, dominantRole: "기타" },
    moodDimensions: { brightness: 0.42, warmth: 0.55, valence: 0.45, arousal: 0.55, tension: 0.48, spaciousness: 0.9, weight: 0.68, aggression: 0.32 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.56, bpm: 118, onsetRate: 2.1, transientDensity: 0.35, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.42, warmth: 0.55, density: 0.88, roughness: 0.7, sustain: 0.86, spaciousness: 0.9, subWeight: 0.56, bpm: 118, pulseRegularity: 0.62 })
  }),
  // No rhythmic grid, no production markers: club/4-on-the-floor vocabulary must have nothing to
  // attach to. Only texture/space/mood evidence is real here.
  ambient: () => ({
    genre: { family: "Ambient / Cinematic", primary: "Ambient", uncertain: false, confidence: 0.8, secondary: [] },
    rhythmicGrammar: { fourOnFloor: null, swing: null, syncopation: null, brokenBeat: null, confidence: 0, onsetCount: 2 },
    productionEvidence: {},
    instruments: [instrument("Synth Pad", 0.4)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null, leadInstrument: null, soloInstrument: null },
    arrangement: { density: 0.15, verifiedEnsembleSize: null, dominantRole: null },
    moodDimensions: { brightness: 0.3, warmth: 0.5, valence: 0.5, arousal: 0.08, tension: 0.12, spaciousness: 0.9, weight: 0.3, aggression: 0.02 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.2, bpm: 0, onsetRate: 0.2, transientDensity: 0.04, sampleCount: 60 },
    audio: { bpm: 0, beatConfidence: 0.05 },
    trackCharacter: { ...trackCharacterFrom({ brightness: 0.3, warmth: 0.5, density: 0.15, sustain: 0.95,
      spaciousness: 0.92, subWeight: 0.2, bpm: 0, pulseRegularity: 0.1, tonalness: 0.85 }),
      harmony: { tonalness: 0.85, harmonicMotion: 0.1, chromaEntropy: 0.15 } }
  }),
  // Genre confidence sits below every CONTEXT/relation gate (0.6-0.75) on purpose: FACT/LIVE
  // should still work from real acoustic measurements while CONTEXT stays mostly silent.
  uncertain: () => ({
    genre: { family: "Unknown", primary: "Experimental", uncertain: false, confidence: 0.5, secondary: [] },
    rhythmicGrammar: { fourOnFloor: 0.5, swing: 0.3, syncopation: 0.4, brokenBeat: 0.3, confidence: 0.6, onsetCount: 20,
      subdivisionRatio: 1.2, accentPeriodicity: 4, accentPlacement: 0.3, kickPeriodicity: 0.4,
      halfTimeLikelihood: 0.15, doubleTimeLikelihood: 0.15, groovePushPull: 0.0, microTimingDeviation: 0.25, rhythmicEntropy: 0.4 },
    productionEvidence: {},
    instruments: [instrument("Synthesizer", 0.5)],
    performance: { soloLikelihood: null, walkingBassLikelihood: null, leadLikelihood: null, leadInstrument: null, soloInstrument: null },
    arrangement: { density: 0.5, verifiedEnsembleSize: null, dominantRole: null },
    moodDimensions: { brightness: 0.5, warmth: 0.5, valence: 0.5, arousal: 0.5, tension: 0.4, spaciousness: 0.5, weight: 0.5, aggression: 0.2 },
    expressionFeatures: { audible: true, observationSeconds: 30, bass: 0.4, bpm: 118, onsetRate: 2, transientDensity: 0.4, sampleCount: 60 },
    trackCharacter: trackCharacterFrom({ brightness: 0.5, warmth: 0.5, density: 0.5, subWeight: 0.5, bpm: 118, pulseRegularity: 0.55 })
  })
};

// Harmonic and melodic material per scenario, kept beside the scenarios rather than inside them
// so the two evidence layers stay easy to compare across fixtures. `harmony: null` / `melody: null`
// means the fixture deliberately offers nothing for that detector to read -- a real case (a
// drum-led jungle roller has no readable lead pitch, a guitar wall has no separable melody) and
// the negative half of section 19's positive/negative/borderline matrix.
const MUSICAL_EVIDENCE = {
  // Bright 4-chord sample loop; the "vocal chop" is a short cell repeated verbatim.
  futurefunk: {
    harmony: { progression: [[0, "maj7"], [9, "min7"], [2, "min7"], [7, "maj"]], framesPerChord: 8, repeats: 3 },
    melody: { notes: [[12, 3], [14, 3], [12, 3], [12, 3], [14, 3], [12, 3], [12, 3], [14, 3], [12, 3], [12, 3], [14, 3], [12, 3]],
      clarity: 0.32, phraseAfter: [2, 5, 8, 11] }
  },
  // Same genre, different material: a longer City-Pop-derived progression and a sung, stepwise arc.
  futurefunkb: {
    harmony: { progression: [[0, "maj7"], [5, "maj7"], [9, "min7"], [2, "min7"], [7, "maj"], [4, "min7"]], framesPerChord: 14, repeats: 2 },
    melody: { notes: [[0, 4], [2, 4], [4, 5], [5, 4], [7, 6], [5, 4], [4, 4], [2, 5], [0, 6], [2, 4], [4, 4], [0, 6]],
      clarity: 0.34, phraseAfter: [5, 11] }
  },
  citypop: {
    harmony: { progression: [[0, "maj7"], [4, "min7"], [9, "min7"], [5, "maj7"], [7, "sus"], [7, "maj"]], framesPerChord: 12, repeats: 2 },
    melody: { notes: [[7, 4], [9, 4], [11, 5], [12, 6], [11, 4], [9, 4], [7, 5], [5, 6], [7, 4], [9, 5], [7, 6], [4, 6]],
      clarity: 0.33, phraseAfter: [5, 11] }
  },
  // Same genre as `citypop`, opposite material: harmony that barely moves under a falling vocal.
  citypopb: {
    harmony: { progression: [[9, "min7"], [4, "min7"]], framesPerChord: 26, repeats: 2, tonalFocus: 0.8 },
    melody: { notes: [[16, 6], [14, 6], [12, 7], [11, 6], [9, 8], [7, 6], [9, 6], [7, 7], [5, 8], [4, 6], [2, 6], [0, 8]],
      clarity: 0.3, phraseAfter: [4, 8, 11] }
  },
  // Two-chord bed, and chopped vocal fragments that jump register instead of forming a line.
  ukgarage: {
    harmony: { progression: [[9, "min7"], [2, "min7"]], framesPerChord: 16, repeats: 3 },
    melody: { notes: [[14, 3], [9, 3], [16, 3], [9, 3], [14, 3], [21, 3], [9, 3], [16, 3], [14, 3], [9, 3]],
      clarity: 0.22, phraseAfter: [3, 6, 9] }
  },
  // Drum-and-bass-led: one sustained harmonic bed, no readable lead pitch at all.
  jungle: { harmony: { progression: [[9, "min"]], framesPerChord: 40, repeats: 1 }, melody: null },
  // A static minor loop with no isolated lead: repetition and production, not melody, identify it.
  techno: { harmony: { progression: [[9, "min"]], framesPerChord: 48, repeats: 1 }, melody: null },
  liquiddnb: {
    harmony: { progression: [[9, "min7"], [0, "maj7"]], framesPerChord: 22, repeats: 2 },
    melody: { notes: [[16, 6], [14, 5], [12, 6], [11, 5], [9, 7], [7, 6], [9, 5], [7, 8], [5, 6], [7, 7]], clarity: 0.3, phraseAfter: [4] }
  },
  // Static one-chord vamp with a leaping bass-led riff: harmony barely moves, the line does.
  funk: {
    harmony: { progression: [[0, "min7"]], framesPerChord: 30, repeats: 2 },
    melody: { notes: [[0, 3], [12, 3], [3, 3], [10, 3], [0, 3], [12, 3], [3, 3], [10, 3], [0, 4], [7, 3], [0, 4]],
      clarity: 0.31, phraseAfter: [3, 7] }
  },
  // Fast harmonic rhythm and phrases that answer each other across registers.
  jazztrio: {
    harmony: { progression: [[2, "min7"], [7, "maj7"], [0, "maj7"], [5, "maj7"], [9, "min7"], [2, "min7"], [7, "maj7"], [0, "maj7"]],
      framesPerChord: 5, repeats: 3 },
    melody: { notes: [[14, 3], [16, 3], [17, 4], [16, 3], [2, 3], [4, 3], [5, 4], [4, 3], [14, 3], [17, 3], [16, 4],
      [2, 3], [5, 3], [4, 4]], clarity: 0.36, phraseAfter: [3, 7, 10, 13] }
  },
  // Same genre as `jazztrio`, opposite material: harmony that lingers under a long arched line.
  jazzballad: {
    harmony: { progression: [[2, "min7"], [7, "sus"], [0, "maj7"]], framesPerChord: 24, repeats: 2, tonalFocus: 0.82 },
    melody: { notes: [[0, 6], [4, 6], [7, 7], [11, 6], [14, 8], [11, 6], [7, 7], [4, 6], [0, 8], [4, 6], [7, 6], [2, 8]],
      clarity: 0.34, phraseAfter: [4, 8, 11] }
  },
  // A guitar wall: harmony changes slowly, and no single pitch stands clear of the distortion.
  shoegaze: { harmony: { progression: [[4, "maj"], [9, "min"]], framesPerChord: 26, repeats: 2 }, melody: { notes: [[12, 8], [12, 8], [11, 8]], clarity: 0.05 } },
  ambient: { harmony: { progression: [[0, "maj7"]], framesPerChord: 60, repeats: 1 }, melody: null },
  // Borderline on purpose: an unsteady two-chord bed and a faint, irregular line.
  uncertain: {
    harmony: { progression: [[0, "sus"], [5, "sus"]], framesPerChord: 12, repeats: 2 },
    melody: { notes: [[7, 3], [10, 3], [6, 3], [11, 3], [8, 3], [12, 3], [6, 3], [9, 3], [11, 3]], clarity: 0.12 }
  }
};

// Temporal and spatial evidence that production really does produce (instrumentationEventEngine
// supplies lead-transition/foreground values and entrance/exit events, rhythmicGrammar.production
// supplies stereoWidth, arrangementEngine supplies a verified ensemble size, and expressionFeatures
// carries the frame-to-frame deltas). The fixtures previously left all of it out, which made a
// group of arrangement/space/energy idioms look permanently dead when in fact only the FIXTURES
// were silent. Values stay modest and are chosen to match each scenario's own story.
const TEMPORAL_EVIDENCE = {
  futurefunk: { leadTransitionRate: 0.1, stereoWidth: 0.72, foregroundLikelihood: 0.72, dominanceChange: 0.14,
    deltaEnergy: 0.14, deltaTransientDensity: 0.12, flux: 0.32,
    instrumentEvents: [{ kind: "entrance", label: "신스", confidence: 0.72, at: 1 }] },
  futurefunkb: { leadTransitionRate: 0.2, stereoWidth: 0.66, foregroundLikelihood: 0.55, dominanceChange: 0.2,
    deltaEnergy: 0.04, deltaTransientDensity: 0.05, flux: 0.22 },
  citypop: { leadTransitionRate: 0.26, stereoWidth: 0.68, foregroundLikelihood: 0.5, dominanceChange: 0.24,
    deltaEnergy: 0.02, deltaTransientDensity: 0.03, flux: 0.2 },
  citypopb: { leadTransitionRate: 0.12, stereoWidth: 0.8, foregroundLikelihood: 0.68, dominanceChange: 0.1,
    deltaEnergy: -0.06, deltaTransientDensity: -0.04, flux: 0.12 },
  ukgarage: { leadTransitionRate: 0.3, stereoWidth: 0.58, foregroundLikelihood: 0.44, dominanceChange: 0.28,
    deltaEnergy: 0.08, deltaTransientDensity: 0.16, flux: 0.4 },
  jungle: { leadTransitionRate: 0.12, stereoWidth: 0.5, foregroundLikelihood: 0.7, dominanceChange: 0.1,
    deltaEnergy: 0.32, deltaTransientDensity: 0.38, flux: 0.6,
    instrumentEvents: [{ kind: "exit", label: "베이스", confidence: 0.66, at: 1 }] },
  techno: { leadTransitionRate: 0.08, stereoWidth: 0.44, foregroundLikelihood: 0.58, dominanceChange: 0.08,
    deltaEnergy: 0.12, deltaTransientDensity: 0.1, deltaCentroid: 0.18, flux: 0.55,
    instrumentEvents: [{ kind: "entrance", label: "신스", confidence: 0.64, at: 1 }] },
  liquiddnb: { leadTransitionRate: 0.16, stereoWidth: 0.84, foregroundLikelihood: 0.42, dominanceChange: 0.14,
    deltaEnergy: -0.2, deltaTransientDensity: -0.12, flux: 0.26 },
  funk: { leadTransitionRate: 0.28, stereoWidth: 0.46, foregroundLikelihood: 0.66, dominanceChange: 0.26,
    deltaEnergy: 0.06, deltaTransientDensity: 0.08, flux: 0.34 },
  // A verified quartet: piano, bass, saxophone and drums are each independently confident here,
  // which is what "verified" means -- it is not a guess from overall density.
  jazztrio: { leadTransitionRate: 0.34, stereoWidth: 0.55, foregroundLikelihood: 0.7, dominanceChange: 0.3,
    verifiedEnsembleSize: 4, deltaEnergy: 0.05, deltaTransientDensity: 0.04, flux: 0.24 },
  // A verified trio: piano, bass and drums, and only those three.
  jazzballad: { leadTransitionRate: 0.14, stereoWidth: 0.62, foregroundLikelihood: 0.68, dominanceChange: 0.12,
    verifiedEnsembleSize: 3, deltaEnergy: -0.04, deltaTransientDensity: -0.03, flux: 0.14 },
  shoegaze: { leadTransitionRate: 0.08, stereoWidth: 0.9, foregroundLikelihood: 0.3, dominanceChange: 0.06,
    deltaEnergy: 0.1, deltaTransientDensity: 0.04, flux: 0.18 },
  ambient: { leadTransitionRate: 0.02, stereoWidth: 0.88, foregroundLikelihood: 0.2, dominanceChange: 0.02,
    deltaEnergy: -0.02, deltaTransientDensity: -0.01, flux: 0.04 },
  uncertain: { leadTransitionRate: 0.2, stereoWidth: 0.5, foregroundLikelihood: 0.5, dominanceChange: 0.2,
    deltaEnergy: 0.0, deltaTransientDensity: 0.0, flux: 0.2 }
};

function applyTemporalEvidence(state, kind) {
  const evidence = TEMPORAL_EVIDENCE[kind];
  if (!evidence) return;
  const { leadTransitionRate, foregroundLikelihood, dominanceChange, verifiedEnsembleSize,
    deltaEnergy, deltaTransientDensity, deltaCentroid, flux, instrumentEvents } = evidence;
  state.instrumentation = { ...(state.instrumentation || {}), leadTransitionRate };
  state.performance = { ...(state.performance || {}), foregroundLikelihood, dominanceChange };
  state.arrangement = { ...(state.arrangement || {}), ...(verifiedEnsembleSize ? { verifiedEnsembleSize } : {}) };
  state.expressionFeatures = { ...(state.expressionFeatures || {}), deltaEnergy, deltaTransientDensity, deltaCentroid, flux };
  if (instrumentEvents) state.instrumentEvents = instrumentEvents;
}

function buildRichState(kind) {
  const build = SCENARIOS[kind];
  if (!build) throw new Error(`Unknown rich fixture kind: ${kind}`);
  const state = build();
  state.sessionId = 1; state.semanticEpoch = 1;
  applyTemporalEvidence(state, kind);
  // Detector inputs must exist before the candidate pipeline computes primitives, exactly as
  // semanticEngine.js populates harmonicMotion/pitchEvidence before its own populate() call.
  const evidence = MUSICAL_EVIDENCE[kind] || {};
  const bpm = state.trackCharacter?.rhythm?.bpm || 120;
  // tonalFocus is taken from the fixture's own tonalness rather than restated, so the harmony
  // detector can never be handed more tonal confidence than the fixture actually claims.
  const tonalFocus = state.trackCharacter?.harmony?.tonalness ?? 0.4;
  state.harmonicMotion = evidence.harmony
    ? harmonicMotionFrom({ ...evidence.harmony, bpm, tonalFocus })
    : HarmonicMotion.analyze({});
  state.pitchEvidence = evidence.melody
    ? pitchEvidenceFrom({ ...evidence.melody, bpm })
    : MelodyContour.analyze({});
  // Run the same post-DSP candidate builder as semanticEngine.js. Fixtures provide measured
  // evidence, not pre-authored phrases; production code decides which FACTs that evidence earns.
  CandidatePipeline.populate(state, { idiomEngine: musicalIdiomEngine });
  state.instrumentationEvidence = GenreContext.instrumentEvidence(state);
  // aestheticEvidence must be computed BEFORE genreContextEvidence: genreContextEngine.evaluate()
  // reads state.aestheticEvidence as one of its own inputs, exactly as semanticEngine.js does.
  state.aestheticEvidence = aestheticEvidenceEngine.evaluate(state);
  state.genreContextEvidence = genreContextEngine.evaluate(state);
  LanguageComposition.apply(state);
  state.mood = { fused: state.moodDimensions };
  state.novelty = { score: 0.1, transitionDetected: false };
  state.ml = { lastUpdated: 1 };
  return state;
}

function responseFixture() {
  const Expressions = require("../../js/semantic/musicExpressionEngine");
  const words = Expressions.generate(profile());
  const result = Object.fromEntries(["genre", "live", "dynamics", "mood"].map(category => [category,
    words.filter(item => item.category === category).slice(0, 12).map(item => category === "genre" ?
      { text: item.text, confidence: 0.78, role: "primary", anchors: ["rhythm.pulseRegularity", "timbre.roughness"] } : item.text)]));
  return { status: "completed", model: "test-model", output_text: JSON.stringify(result), usage: { input_tokens: 100, output_tokens: 200 } };
}
// chromaFrames/pitchTrajectory are exported so the detector tests build their positive, negative
// and borderline inputs with the SAME generators the scenario fixtures use -- a detector that only
// passes on hand-tuned test input has not been tested.
module.exports = { profile, responseFixture, RICH_KINDS, chromaFrames, pitchTrajectory, harmonicMotionFrom, pitchEvidenceFrom };
