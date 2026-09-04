const FEATURE_WINDOW = CONFIG.audio.analysisWindowSamples;
const REALTIME_WINDOW = CONFIG.audio.realtimeWindowSamples;

const createFeatureHistory = capacity => new RingBuffer(capacity);
const createBandHistory = () => Object.fromEntries(
  Object.keys(CONFIG.audio.frequencyBands).map(name => [name, createFeatureHistory(REALTIME_WINDOW)])
);

const audioAnalysis = {
  chromaHistory: createFeatureHistory(FEATURE_WINDOW),
  mfccHistory: createFeatureHistory(FEATURE_WINDOW),
  zcrList: createFeatureHistory(FEATURE_WINDOW),
  flatnessList: createFeatureHistory(FEATURE_WINDOW),
  rmsList: createFeatureHistory(FEATURE_WINDOW),
  centroidList: createFeatureHistory(FEATURE_WINDOW),
  rolloffList: createFeatureHistory(FEATURE_WINDOW),
  spreadList: createFeatureHistory(FEATURE_WINDOW),
  skewnessList: createFeatureHistory(FEATURE_WINDOW),
  kurtosisList: createFeatureHistory(FEATURE_WINDOW),
  crestList: createFeatureHistory(FEATURE_WINDOW),
  sharpnessList: createFeatureHistory(FEATURE_WINDOW),
  perceptualSpreadList: createFeatureHistory(FEATURE_WINDOW),
  energyList: createFeatureHistory(FEATURE_WINDOW),
  loudnessList: createFeatureHistory(FEATURE_WINDOW),
  spectralFluxList: createFeatureHistory(REALTIME_WINDOW),
  realtimeCentroidList: createFeatureHistory(REALTIME_WINDOW),
  realtimeEnergyList: createFeatureHistory(REALTIME_WINDOW),
  spectralBalanceList: createFeatureHistory(REALTIME_WINDOW),
  bandHistory: createBandHistory(),
  samples: 0,
  realtimeSamples: 0
};

const realtimeAudioFeatures = {
  bands: Object.fromEntries(Object.keys(CONFIG.audio.frequencyBands).map(name => [name, 0])),
  spectralFlux: 0,
  spectralCentroid: 0,
  spectralBalance: 0,
  energy: 0
};

let previousSpectrumFrame = null;
let latestMeasuredFeatures = {};
let bandPlan = null;
const bassPitchTracker = new BassPitchTracker.Tracker();
// A missing script tag must never prevent the rest of audioFeatures from loading: that is
// exactly what froze the launcher (start button never bound a working capture path).
const melodyPitchTracker = typeof MelodyPitchTracker === "object" && MelodyPitchTracker.Tracker
  ? new MelodyPitchTracker.Tracker()
  : { observeFrame() {}, reset() {}, trajectory() { return []; } };
const bassEnergyEnvelope = new RingBuffer(600);
const statsCache = new WeakMap();
let cachedLocalMood = { valence: 0.5, arousal: 0, tension: 0, warmth: 0.5, brightness: 0.5, spaciousness: 0.5 };
let cachedLocalMoodAt = -Infinity;
let cachedInstrumentEvidence = { descriptors: {}, candidates: [] };
let cachedInstrumentEvidenceAt = -Infinity;

function historyValues(history) {
  return history instanceof RingBuffer ? history.values() : (history || []);
}

function pushLimited(array, value, limit = FEATURE_WINDOW) {
  if (!Number.isFinite(Number(value))) return;
  if (array instanceof RingBuffer) {
    array.push(Number(value));
    return;
  }
  array.push(Number(value));
  if (array.length > limit) array.splice(0, array.length - limit);
}

function pushVectorLimited(array, vector, expectedLength, limit = FEATURE_WINDOW) {
  if (!Array.isArray(vector) || (expectedLength && vector.length !== expectedLength)) return;
  if (array instanceof RingBuffer) {
    array.push(vector.map(value => Number(value) || 0));
    return;
  }
  array.push(vector.map(value => Number(value) || 0));
  if (array.length > limit) array.splice(0, array.length - limit);
}

function resetAudioAnalysis() {
  for (const [key, value] of Object.entries(audioAnalysis)) {
    if (value instanceof RingBuffer) value.clear();
  }
  for (const history of Object.values(audioAnalysis.bandHistory)) history.clear();
  audioAnalysis.samples = 0;
  audioAnalysis.realtimeSamples = 0;
  previousSpectrumFrame = null;
  latestMeasuredFeatures = {};
  bandPlan = null;
  bassPitchTracker.reset();
  melodyPitchTracker.reset();
  bassEnergyEnvelope.clear();
  cachedLocalMoodAt = -Infinity;
  cachedInstrumentEvidenceAt = -Infinity;
  Object.assign(realtimeAudioFeatures, {
    bands: Object.fromEntries(Object.keys(CONFIG.audio.frequencyBands).map(name => [name, 0])),
    spectralFlux: 0,
    spectralCentroid: 0,
    spectralBalance: 0,
    energy: 0
  });
}

function updateRealtimeSpectrumAnalysis() {
  if (!audioFrequencyData || !audioContext || !analyser) return;

  if (!bandPlan) {
    bandPlan = SignalMath.createBandPlan(
      audioContext.sampleRate,
      analyser.fftSize,
      CONFIG.audio.frequencyBands,
      audioFrequencyData.length
    );
  }
  const bands = SignalMath.averageBandsWithPlan(audioFrequencyData, bandPlan);
  const flux = SignalMath.spectralFlux(audioFrequencyData, previousSpectrumFrame);
  const centroid = SignalMath.spectralCentroid(
    audioFrequencyData,
    audioContext.sampleRate,
    analyser.fftSize
  );

  const lowEnergy = bands.subBass + bands.bass + bands.lowMid;
  const highEnergy = bands.highMid + bands.brilliance + bands.air;
  const totalBandEnergy = Object.values(bands).reduce((sum, value) => sum + value, 0);
  const energy = totalBandEnergy / Math.max(1, Object.keys(bands).length);
  const spectralBalance = (highEnergy - lowEnergy) / Math.max(0.0001, highEnergy + lowEnergy);

  realtimeAudioFeatures.bands = bands;
  realtimeAudioFeatures.spectralFlux = flux;
  realtimeAudioFeatures.spectralCentroid = centroid;
  realtimeAudioFeatures.spectralBalance = spectralBalance;
  realtimeAudioFeatures.energy = energy;

  const framePitchAt = performance.now();
  bassPitchTracker.observeFrame(audioFrequencyData, audioContext.sampleRate, analyser.fftSize, framePitchAt);
  melodyPitchTracker.observeFrame(audioFrequencyData, audioContext.sampleRate, analyser.fftSize, framePitchAt);
  bassEnergyEnvelope.push({ at: framePitchAt, value: bands.subBass + bands.bass });

  for (const [name, value] of Object.entries(bands)) {
    pushLimited(audioAnalysis.bandHistory[name], value, REALTIME_WINDOW);
  }
  pushLimited(audioAnalysis.spectralFluxList, flux, REALTIME_WINDOW);
  pushLimited(audioAnalysis.realtimeCentroidList, centroid, REALTIME_WINDOW);
  pushLimited(audioAnalysis.realtimeEnergyList, energy, REALTIME_WINDOW);
  pushLimited(audioAnalysis.spectralBalanceList, spectralBalance, REALTIME_WINDOW);

  audioAnalysis.realtimeSamples = audioAnalysis.spectralFluxList.length;
  if (!previousSpectrumFrame || previousSpectrumFrame.length !== audioFrequencyData.length) {
    previousSpectrumFrame = new Uint8Array(audioFrequencyData.length);
  }
  previousSpectrumFrame.set(audioFrequencyData);
}

function processMeydaFeatures(features) {
  if (!features) return;
  const rms = Number(features.rms) || 0;
  latestMeasuredFeatures = {
    rms, flatness: Number(features.spectralFlatness) || 0,
    zcr: (Number(features.zcr) || 0) / CONFIG.audio.meydaBufferSize,
    chroma: Array.from(features.chroma || [], Number),
    measuredAt: Date.now()
  };
  // Keep silence: the old loud passage must not survive indefinitely in history.

  pushVectorLimited(audioAnalysis.chromaHistory, features.chroma, 12);
  pushVectorLimited(audioAnalysis.mfccHistory, features.mfcc);
  pushLimited(audioAnalysis.zcrList, features.zcr);
  pushLimited(audioAnalysis.flatnessList, features.spectralFlatness);
  pushLimited(audioAnalysis.rmsList, rms);
  pushLimited(audioAnalysis.centroidList, features.spectralCentroid);
  pushLimited(audioAnalysis.rolloffList, features.spectralRolloff);
  pushLimited(audioAnalysis.spreadList, features.spectralSpread);
  pushLimited(audioAnalysis.skewnessList, features.spectralSkewness);
  pushLimited(audioAnalysis.kurtosisList, features.spectralKurtosis);
  pushLimited(audioAnalysis.crestList, features.spectralCrest);
  pushLimited(audioAnalysis.sharpnessList, features.perceptualSharpness);
  pushLimited(audioAnalysis.perceptualSpreadList, features.perceptualSpread);
  pushLimited(audioAnalysis.energyList, features.energy);
  pushLimited(audioAnalysis.loudnessList, features.loudness?.total);
  audioAnalysis.samples = audioAnalysis.rmsList.length;
}

function getFeatureStats(array) {
  if (!(array instanceof RingBuffer)) return SignalMath.robustStats(array);
  const cached = statsCache.get(array);
  if (cached?.version === array.version) return cached.value;
  const value = SignalMath.robustStats(array.values());
  statsCache.set(array, { version: array.version, value });
  return value;
}

function averageVectorHistory(history) {
  const values = historyValues(history);
  if (!values.length) return [];
  const size = values[0].length;
  const result = new Array(size).fill(0);
  for (const frame of values) {
    for (let index = 0; index < size; index++) result[index] += Number(frame[index]) || 0;
  }
  return result.map(value => value / values.length);
}

function vectorStdHistory(history, means) {
  const values = historyValues(history);
  if (!values.length || !means?.length) return [];
  return means.map((mean, index) =>
    Math.sqrt(
      values.reduce((sum, frame) => sum + Math.pow((Number(frame[index]) || 0) - mean, 2), 0) /
      values.length
    )
  );
}

function getChromaProfile() {
  const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const average = averageVectorHistory(audioAnalysis.chromaHistory);
  if (!average.length) {
    return { vector: new Array(12).fill(0), dominantNotes: [], entropy: 1, confidence: 0 };
  }

  const total = average.reduce((sum, value) => sum + Math.max(0, value), 0);
  const vector = average.map(value => (total ? Math.max(0, value) / total : 0));
  const entropy = -vector.reduce(
    (sum, probability) => sum + (probability > 0 ? probability * Math.log(probability) : 0),
    0
  ) / Math.log(12);
  const dominantNotes = vector
    .map((strength, index) => ({ note: notes[index], strength }))
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 4);

  return {
    vector,
    dominantNotes,
    entropy,
    confidence: SignalMath.clamp(1 - entropy)
  };
}

function getMFCCProfile() {
  const mean = averageVectorHistory(audioAnalysis.mfccHistory);
  return { mean, std: vectorStdHistory(audioAnalysis.mfccHistory, mean) };
}

function computeLocalMoodProfile() {
  const bands = realtimeAudioFeatures.bands;
  const low = bands.subBass + bands.bass + bands.lowMid;
  const high = bands.highMid + bands.brilliance + bands.air;
  const total = low + bands.mid + high + 0.0001;
  const rms = getFeatureStats(audioAnalysis.rmsList);
  const flatness = getFeatureStats(audioAnalysis.flatnessList);
  const flux = getFeatureStats(audioAnalysis.spectralFluxList);
  const spread = getFeatureStats(audioAnalysis.spreadList);
  const energy = realtimeAudioFeatures.energy;
  const brightness = SignalMath.clamp((high / total) * 1.45);
  const warmth = SignalMath.clamp((low / total) * 1.55);
  const arousal = SignalMath.clamp(rms.mean * 3.2 + energy * 1.35 + flux.mean * 8);
  const tension = SignalMath.clamp(
    flatness.mean * 0.38 + brightness * 0.32 + flux.std * 14 + Math.max(0, realtimeAudioFeatures.spectralBalance) * 0.18
  );
  const spaciousness = SignalMath.clamp(spread.mean / 6500 + flatness.mean * 0.16);
  const valence = SignalMath.clamp(0.43 + brightness * 0.22 + warmth * 0.13 - tension * 0.2);

  return { valence, arousal, tension, warmth, brightness, spaciousness };
}

function getLocalMoodProfile(force = false) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (force || now - cachedLocalMoodAt >= CONFIG.semantic.localMoodInterval) {
    cachedLocalMood = computeLocalMoodProfile();
    cachedLocalMoodAt = now;
  }
  return cachedLocalMood;
}

function computeInstrumentEvidenceProfile() {
  const bandStats = Object.fromEntries(
    Object.entries(audioAnalysis.bandHistory).map(([name, history]) => [name, getFeatureStats(history)])
  );
  const bandMeans = Object.fromEntries(
    Object.entries(bandStats).map(([name, stats]) => [name, stats.mean])
  );
  const total = Object.values(bandMeans).reduce((sum, value) => sum + value, 0) + 0.0001;
  const lowShare = SignalMath.clamp(
    (bandMeans.subBass + bandMeans.bass + bandMeans.lowMid) / total
  );
  const midShare = SignalMath.clamp((bandMeans.lowMid + bandMeans.mid + bandMeans.highMid * 0.35) / total);
  const highShare = SignalMath.clamp(
    (bandMeans.highMid + bandMeans.brilliance + bandMeans.air) / total
  );

  const flux = getFeatureStats(audioAnalysis.spectralFluxList);
  const rms = getFeatureStats(audioAnalysis.rmsList);
  const flatness = getFeatureStats(audioAnalysis.flatnessList);
  const chroma = getChromaProfile();
  const rhythm = getRhythmProfile();
  const mood = getLocalMoodProfile();
  const chromaMotion = SignalMath.clamp(
    SignalMath.meanVectorDistance(historyValues(audioAnalysis.chromaHistory)) * 5
  );
  const transientDensity = SignalMath.ratioAbove(
    historyValues(audioAnalysis.spectralFluxList),
    Math.max(CONFIG.beat.minFlux, flux.mean + flux.std * 0.75)
  );
  const fluxActivity = SignalMath.clamp(flux.mean * 18 + flux.std * 26);
  const dynamicVariation = SignalMath.clamp(rms.std / Math.max(0.002, rms.mean) / 1.25);
  const bassVariation = SignalMath.clamp(
    (bandStats.subBass.std + bandStats.bass.std) /
      Math.max(0.002, bandStats.subBass.mean + bandStats.bass.mean) /
      1.35
  );
  const tonalFocus = SignalMath.clamp(chroma.confidence);
  const sustain = SignalMath.clamp(
    (1 - transientDensity) * 0.28 +
      (1 - fluxActivity) * 0.24 +
      (1 - dynamicVariation) * 0.2 +
      (1 - SignalMath.clamp(flatness.mean)) * 0.16 +
      mood.spaciousness * 0.12
  );

  const candidates = [
    {
      id: "bassline",
      label: "베이스라인",
      score: SignalMath.clamp(
        lowShare * 0.4 + bassVariation * 0.24 + rhythm.confidence * 0.16 + transientDensity * 0.12 + chromaMotion * 0.08
      ),
      evidence: { lowShare, bassVariation, pulseLock: rhythm.confidence }
    },
    {
      id: "pianoKeys",
      label: "피아노·건반",
      score: SignalMath.clamp(
        tonalFocus * 0.25 + transientDensity * 0.24 + midShare * 0.18 + chromaMotion * 0.15 + dynamicVariation * 0.1 + (1 - flatness.mean) * 0.08
      ),
      evidence: { tonalFocus, transientDensity, chromaMotion, midShare }
    },
    {
      id: "synthPad",
      label: "신스 패드·지속 화음",
      score: SignalMath.clamp(
        sustain * 0.34 + tonalFocus * 0.2 + midShare * 0.16 + mood.spaciousness * 0.12 + (1 - transientDensity) * 0.1 + (1 - dynamicVariation) * 0.08
      ),
      evidence: { sustain, tonalFocus, spaciousness: mood.spaciousness, transientDensity }
    },
    {
      id: "percussion",
      label: "드럼·퍼커션",
      score: SignalMath.clamp(
        transientDensity * 0.36 + fluxActivity * 0.22 + rhythm.confidence * 0.2 + highShare * 0.12 + dynamicVariation * 0.1
      ),
      evidence: { transientDensity, fluxActivity, pulseLock: rhythm.confidence, highShare }
    }
  ].sort((left, right) => right.score - left.score);

  return {
    descriptors: {
      lowShare,
      midShare,
      highShare,
      tonalFocus,
      chromaMotion,
      transientDensity,
      dynamicVariation,
      bassVariation,
      sustain
    },
    candidates
  };
}

function getInstrumentEvidenceProfile(force = false) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (force || now - cachedInstrumentEvidenceAt >= CONFIG.semantic.instrumentInterval) {
    cachedInstrumentEvidence = computeInstrumentEvidenceProfile();
    cachedInstrumentEvidenceAt = now;
  }
  return cachedInstrumentEvidence;
}

function getAdvancedAudioProfile() {
  const spectrum = Object.fromEntries(
    Object.entries(audioAnalysis.bandHistory).map(([name, history]) => [name, getFeatureStats(history)])
  );

  return {
    samples: audioAnalysis.samples,
    realtimeSamples: audioAnalysis.realtimeSamples,
    sampleRate: audioContext?.sampleRate || 0,
    fftSize: analyser?.fftSize || CONFIG.audio.fftSize,
    harmony: {
      chroma: getChromaProfile(),
      mfcc: getMFCCProfile()
    },
    dynamics: {
      rms: getFeatureStats(audioAnalysis.rmsList),
      energy: getFeatureStats(audioAnalysis.energyList),
      loudness: getFeatureStats(audioAnalysis.loudnessList),
      realtimeEnergy: getFeatureStats(audioAnalysis.realtimeEnergyList)
    },
    timbre: {
      zcr: getFeatureStats(audioAnalysis.zcrList),
      flatness: getFeatureStats(audioAnalysis.flatnessList),
      centroid: getFeatureStats(audioAnalysis.centroidList),
      rolloff: getFeatureStats(audioAnalysis.rolloffList),
      spread: getFeatureStats(audioAnalysis.spreadList),
      skewness: getFeatureStats(audioAnalysis.skewnessList),
      kurtosis: getFeatureStats(audioAnalysis.kurtosisList),
      crest: getFeatureStats(audioAnalysis.crestList),
      sharpness: getFeatureStats(audioAnalysis.sharpnessList),
      perceptualSpread: getFeatureStats(audioAnalysis.perceptualSpreadList)
    },
    spectrum: {
      bands: spectrum,
      flux: getFeatureStats(audioAnalysis.spectralFluxList),
      centroid: getFeatureStats(audioAnalysis.realtimeCentroidList),
      balance: getFeatureStats(audioAnalysis.spectralBalanceList)
    },
    instrumentationEvidence: getInstrumentEvidenceProfile(),
    localMood: getLocalMoodProfile()
  };
}

function getBassPitchProfile(onsetTimestamps = []) {
  return bassPitchTracker.profile(onsetTimestamps);
}

function getBassEnergyEnvelope() {
  return bassEnergyEnvelope.values();
}

// Predominant-pitch trajectory for the melodic register (section 5). Raw samples, oldest first;
// note segmentation and shape analysis belong to melodyContourEngine so that logic stays pure.
function getMelodyPitchTrajectory(windowMs = 0) {
  return melodyPitchTracker.trajectory(windowMs, performance.now());
}

// The chroma SEQUENCE, not its average. getChromaProfile() collapses the window into one mean
// vector, which is exactly the information harmonic-motion analysis needs to keep (section 4).
function getChromaSequence(limit = 120) {
  const frames = historyValues(audioAnalysis.chromaHistory);
  return frames.length > limit ? frames.slice(-limit) : frames;
}

function createAudioFeatureFingerprint() {
  const mood = getLocalMoodProfile();
  const rms = getFeatureStats(audioAnalysis.rmsList);
  const flux = getFeatureStats(audioAnalysis.spectralFluxList);
  const chroma = getChromaProfile();
  const bands = realtimeAudioFeatures.bands;
  const instrumentation = getInstrumentEvidenceProfile();
  return [
    SignalMath.clamp(rms.mean * 4),
    SignalMath.clamp(realtimeAudioFeatures.energy * 2),
    SignalMath.clamp(flux.mean * 12),
    SignalMath.clamp(realtimeAudioFeatures.spectralCentroid / 12000),
    ...Object.keys(CONFIG.audio.frequencyBands).map(name => SignalMath.clamp(bands[name] * 2)),
    chroma.confidence,
    mood.valence,
    mood.arousal,
    mood.tension,
    mood.warmth,
    mood.spaciousness,
    ...instrumentation.candidates.map(candidate => candidate.score)
  ];
}
