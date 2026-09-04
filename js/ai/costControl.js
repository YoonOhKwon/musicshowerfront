const CostControl = (() => {
  const roundNumber = (value, digits = 3) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : 0;
  };

  const compactNumbers = (value, digits = 3) => {
    if (typeof value === "number") return roundNumber(value, digits);
    if (Array.isArray(value)) return value.map(item => compactNumbers(item, digits));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, compactNumbers(nested, digits)])
      );
    }
    return value;
  };

  const compactStats = stats => ({
    mean: stats?.mean || 0,
    std: stats?.std || 0,
    median: stats?.median || 0,
    p10: stats?.p10 || 0,
    p90: stats?.p90 || 0
  });

  const compactStatMap = source => Object.fromEntries(
    Object.entries(source || {}).map(([name, stats]) => [name, compactStats(stats)])
  );

  function compactAudioProfile(audio = {}) {
    const chroma = audio.harmony?.chroma || {};
    const mfcc = audio.harmony?.mfcc || {};
    const evidence = audio.instrumentationEvidence || {};

    return compactNumbers({
      samples: audio.samples || 0,
      sampleRate: audio.sampleRate || 0,
      fftSize: audio.fftSize || 0,
      harmony: {
        chroma: {
          vector: (chroma.vector || []).slice(0, 12),
          dominantNotes: (chroma.dominantNotes || []).slice(0, 4),
          entropy: chroma.entropy || 0,
          confidence: chroma.confidence || 0
        },
        mfcc: {
          mean: (mfcc.mean || []).slice(0, 13),
          std: (mfcc.std || []).slice(0, 13)
        }
      },
      dynamics: compactStatMap({
        rms: audio.dynamics?.rms,
        energy: audio.dynamics?.energy,
        loudness: audio.dynamics?.loudness
      }),
      timbre: compactStatMap(audio.timbre),
      spectrum: {
        bands: compactStatMap(audio.spectrum?.bands),
        flux: compactStats(audio.spectrum?.flux),
        centroid: compactStats(audio.spectrum?.centroid),
        balance: compactStats(audio.spectrum?.balance)
      },
      instrumentationEvidence: {
        descriptors: evidence.descriptors || {},
        candidates: (evidence.candidates || []).slice(0, 4)
      },
      localMood: audio.localMood || {}
    });
  }

  function createFeaturePacket({ audio, rhythm, inputMode, windowSeconds }) {
    return compactNumbers({
      version: 3,
      inputMode,
      windowSeconds,
      rhythm,
      audio: compactAudioProfile(audio)
    });
  }

  function fingerprintKey(fingerprint, step = 0.05) {
    const safeStep = Math.max(0.001, Number(step) || 0.05);
    return (fingerprint || [])
      .map(value => Math.round((Number(value) || 0) / safeStep))
      .join(":");
  }

  return {
    compactNumbers,
    compactStats,
    compactAudioProfile,
    createFeaturePacket,
    fingerprintKey
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CostControl;
