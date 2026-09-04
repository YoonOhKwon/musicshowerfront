const MIR = require("../js/mir/mirEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Fusion = require("../js/semantic/evidenceFusionEngine");
const Temporal = require("../js/semantic/temporalEvidenceEngine");
const lexicon = require("../data/musicalLexicon.json");

const mir = new MIR.Engine();
const idioms = new Idioms.Engine(lexicon);
const fusion = new Fusion.Engine();
const temporal = new Temporal.Engine();
const samples = [];
const chroma = [1, .1, .2, .1, .82, .35, .1, .88, .1, .2, .1, .22];
const state = {
  rhythm: { bpm: 120, confidence: .86, beatConfidence: .86, tempoStability: .82, onsetRate: 3.2 },
  audio: { bpm: 120, beatConfidence: .86, tonalFocus: .78, chroma, bass: .58, high: .22 },
  rhythmicGrammar: { subdivisionRatio: 1, accentPeriodicity: 4, accentPlacement: .08, fourOnFloor: .82 },
  instrumentation: { observed: [{ id: "synthesizer", confidence: .82 }, { id: "bass", confidence: .72 }],
    families: { synth: { confidence: .82 }, bass: { confidence: .72 } }, dominanceDispersion: .72, confidence: .82 },
  arrangement: { density: .68 }, performance: { bassFunction: "ostinato" }, expressionFeatures: { bass: .58, high: .22 },
  productionEvidence: { sidechain: .76 }, novelty: { score: .2 },
  trackCharacter: { confidence: .84, rhythm: { pulseRegularity: .82 }, harmony: { tonalness: .78, harmonicMotion: .35 },
    texture: { sustainedness: .5, density: .68 }, timbre: { transientSharpness: .62 }, dynamics: { dynamicRange: .4, compressionDensity: .7, pumping: .76 },
    production: { saturation: .55, subWeight: .62 }, space: { perceivedDepth: .5 }, structure: { repetition: .76, sectionNovelty: .2, buildupLikelihood: .3, breakdownLikelihood: .2 } },
  genre: { primary: "House", family: "Electronic / Club", confidence: .8 }
};

for (let index = 0; index < 10000; index++) {
  const startedAt = performance.now();
  state.mir = mir.update({ bpm: 120, beatConfidence: .86, chroma, tonalFocus: .78, rhythmicGrammar: state.rhythmicGrammar }, index * 10);
  const primitive = Primitives.analyze(state);
  const local = idioms.evaluate(primitive, state.genre);
  const fused = fusion.fuse({ local, genreModel: [{ text: "House", category: "genre", confidence: .8 }] }, index * 10);
  temporal.update(fused, index * 10);
  samples.push(performance.now() - startedAt);
}
samples.sort((a, b) => a - b);
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
console.log(JSON.stringify({ iterations: samples.length, meanMs: mean, p90Ms: samples[Math.floor(samples.length * .9)],
  p99Ms: samples[Math.floor(samples.length * .99)], maxMs: samples.at(-1) }, null, 2));
