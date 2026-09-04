const ML_QUALITY_PROFILES = Object.freeze({
  performance: Object.freeze({ inferenceInterval: 3200, windows: Object.freeze({ fast: 4, mid: 9, long: 20 }) }),
  balanced: Object.freeze({ inferenceInterval: 2200, windows: Object.freeze({ fast: 5, mid: 12, long: 30 }) }),
  quality: Object.freeze({ inferenceInterval: 1400, windows: Object.freeze({ fast: 7, mid: 18, long: 45 }) })
});

const requestedMLQuality = typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("quality")
  : null;
const requestedMLBackend = typeof location !== "undefined"
  ? new URLSearchParams(location.search).get("backend")
  : null;
const activeMLQuality = Object.hasOwn(ML_QUALITY_PROFILES, requestedMLQuality)
  ? requestedMLQuality
  : "balanced";
const activeMLProfile = ML_QUALITY_PROFILES[activeMLQuality];

const CONFIG = {
  audio: {
    fftSize: 4096,
    smoothing: 0.68,
    meydaBufferSize: 2048,
    minRMS: 0.003,
    mfccCoefficients: 20,
    pcmBlockSize: 4096,
    sharedRingSecondsMargin: 5,
    mlCaptureInterval: 85,
    analysisWindowSamples: 360,
    realtimeWindowSamples: 720,
    frequencyBands: {
      subBass: [20, 60],
      bass: [60, 250],
      lowMid: [250, 500],
      mid: [500, 2000],
      highMid: [2000, 6000],
      brilliance: [6000, 12000],
      air: [12000, 20000]
    }
  },

  beat: {
    cooldown: 180,
    minFlux: 0.0025,
    fluxThresholdStd: 1.15,
    minEnergy: 0.025,
    bassRise: 0.004,
    bpmMin: 65,
    bpmMax: 195,
    bpmFoldMin: 75,
    bpmFoldMax: 175,
    historySize: 24
  },

  visual: {
    maxFloatingWords: 18,
    maxParticles: 560,
    wordMinSize: 26,
    wordMaxSize: 74,
    wordSpawnInterval: 1700,
    wordsPerSpawn: 1,
    wordScrollSpeed: 165,
    wordLaneHeight: 82,
    recentWordMemory: 16,
    wordFadeInFraction: 0.025
  },

  semantic: {
    useLLM: false,
    localMoodInterval: 125,
    instrumentInterval: 450,
    stateInterval: 900,
    wordInterval: 500,
    debug: false
  },

  language: {
    poolSize: 36,
    regenerationFloor: 10,
    minimumIntervalMs: 45000,
    stableDelayMs: 5000,
    cacheSize: 16,
    cacheQuantization: 0.05,
    remote: {
      enabled: typeof location === "undefined" || new URLSearchParams(location.search).get("language") !== "local",
      endpoint: "/api/language-pool",
      timeoutMs: 135000
    },
    localModel: {
      enabled: false,
      model: null,
      batchSize: 60
    }
  },

  ml: {
    enabled: true,
    quality: activeMLQuality,
    qualityProfiles: ML_QUALITY_PROFILES,
    backendPreference: requestedMLBackend === "wasm" ? ["wasm"] : ["webgpu", "wasm"],
    manifestUrl: "/models/music-shower/manifest.json",
    workerUrl: "/js/ml/mlWorker.js",
    inferenceInterval: activeMLProfile.inferenceInterval,
    windows: activeMLProfile.windows,
    genre: {
      topK: 5,
      unknownThreshold: 0.045,
      marginThreshold: 0.006,
      entropyThreshold: 0.97,
      switchMargin: 0.012,
      persistence: 3
    },
    zeroShot: {
      enabled: true,
      confidenceTrigger: 0.45,
      entropyTrigger: 0.78,
      cooldown: 10000
    }
  },

  ai: {
    autoEnrich: false,
    initialDelay: 6000,
    minimumSamples: 100,
    retryDelay: 30000,
    maxRetryDelay: 300000,
    pollInterval: 5000,
    minInterval: 60000,
    maxInterval: 240000,
    changeThreshold: 0.12,
    stableChangePolls: 3,
    cacheQuantization: 0.05,
    profileCacheSize: 24,
    instrumentCandidateThreshold: 0.64,
    requestTimeout: 75000
  }
};
