function fallbackWord(text, category, hue, weight = 0.7, overrides = {}) {
  return {
    text,
    category,
    weight,
    hue,
    saturation: 0.78,
    brightness: 1,
    glow: 1.25,
    speed: 1,
    scale: 1,
    ...overrides
  };
}

function createFallbackProfile() {
  return {
    genreProfile: {
      family: "Unknown",
      primary: "미확정 장르",
      secondary: [
        { name: "미확정", confidence: 0, evidence: "오디오 특징 수집 전" },
        { name: "미확정", confidence: 0, evidence: "오디오 특징 수집 전" }
      ],
      tradition: "미확정",
      characteristics: ["로컬 특징 수집 중"],
      fusionSummary: "검증된 음악 모델이 준비되기 전에는 장르를 추측하지 않습니다.",
      confidence: 0,
      evidence: ["오디오 특징 수집 전", "기본 시각 프로필", "실시간 분석 대기"]
    },
    instrumentationProfile: {
      prominent: [
        { name: "악기 분석 대기", family: "unknown", role: "texture", confidence: 0, evidence: "오디오 특징 수집 전" }
      ],
      arrangement: {
        bassFoundation: "분석 대기",
        harmonicLayer: "분석 대기",
        melodicLead: "분석 대기",
        rhythmicLayer: "분석 대기"
      },
      textures: ["미확정", "특징 수집 중", "구간 분석 대기"],
      confidence: 0
    },
    moodProfile: {
      labels: ["분석 중"],
      valence: 0.5,
      arousal: 0.45,
      tension: 0.35,
      warmth: 0.45,
      spaciousness: 0.72
    },
    visualProfile: {
      primaryHue: 285,
      secondaryHue: 195,
      saturation: 0.78,
      brightness: 0.9,
      pulse: 0.55,
      turbulence: 0.35,
      density: 0.55
    },
    words: [
      fallbackWord("빛", "neutral", 205, 1),
      fallbackWord("파동", "neutral", 225, 1),
      fallbackWord("잔광", "neutral", 285, 0.9),
      fallbackWord("입자", "neutral", 195, 0.82),
      fallbackWord("맥동", "neutral", 338, 0.95),
      fallbackWord("흐름", "neutral", 210, 0.9),
      fallbackWord("공간", "neutral", 248, 0.78),
      fallbackWord("진동", "neutral", 205, 0.9),
      fallbackWord("층", "neutral", 270, 0.72),
      fallbackWord("결", "neutral", 198, 0.76)
    ],
    intensity: 0.5,
    summary: "오디오를 시작하면 현재 구간의 장르와 분위기를 정밀 분석합니다."
  };
}

let musicProfile = createFallbackProfile();
let keywordMatrixReady = true;
let aiProfileLoaded = false;
let aiProfileStatus = "waiting";
let aiAnalysisRunning = false;
let aiAnalysisTimer = null;
let aiAbortController = null;
let aiProfileMeta = null;
let aiProfileErrorMessage = "";
let lastAIAnalysisTime = 0;
let lastAIFingerprint = null;
let lastProfileChange = 1;
let consecutiveProfileChanges = 0;
let aiFailureCount = 0;
const aiProfileCache = new Map();

function createAudioAIFeaturePacket() {
  const audio = getAdvancedAudioProfile();
  const rhythm = getRhythmProfile();
  const windowSeconds = audio.sampleRate
    ? (audio.samples * CONFIG.audio.meydaBufferSize) / audio.sampleRate
    : 0;

  return CostControl.createFeaturePacket({
    rhythm,
    audio,
    inputMode: audioInputMode,
    windowSeconds
  });
}

function getCurrentFeatureFingerprint() {
  const rhythm = getRhythmProfile();
  return [
    ...createAudioFeatureFingerprint(),
    SignalMath.clamp((rhythm.bpm || 0) / 200),
    SignalMath.clamp(rhythm.confidence || 0),
    SignalMath.clamp((rhythm.onsetRate || 0) / 8)
  ];
}

function scheduleAIAnalysis(delay = CONFIG.ai.pollInterval) {
  if (aiAnalysisTimer) clearTimeout(aiAnalysisTimer);
  if (!audioStarted || !CONFIG.semantic.useLLM || !CONFIG.ai.autoEnrich) return;
  aiAnalysisTimer = setTimeout(() => buildMusicProfile(), Math.max(250, delay));
}

function startAIAnalysisLoop() {
  stopAIAnalysisLoop();
  if (!CONFIG.semantic.useLLM) {
    aiProfileStatus = "disabled";
    return;
  }
  if (!CONFIG.ai.autoEnrich) {
    aiProfileStatus = "optional";
    return;
  }
  aiProfileStatus = "collecting";
  lastAIAnalysisTime = 0;
  lastAIFingerprint = null;
  consecutiveProfileChanges = 0;
  scheduleAIAnalysis(CONFIG.ai.initialDelay);
}

function stopAIAnalysisLoop() {
  if (aiAnalysisTimer) clearTimeout(aiAnalysisTimer);
  aiAnalysisTimer = null;
  aiAbortController?.abort();
  aiAbortController = null;
  aiAnalysisRunning = false;
  if (!audioStarted) aiProfileStatus = "waiting";
}

function shouldRequestAIProfile(fingerprint, force) {
  if (force || !aiProfileLoaded || !lastAIFingerprint) {
    consecutiveProfileChanges = 0;
    return true;
  }
  const elapsed = Date.now() - lastAIAnalysisTime;
  if (elapsed < CONFIG.ai.minInterval) return false;
  lastProfileChange = SignalMath.normalizedDistance(fingerprint, lastAIFingerprint);
  if (elapsed >= CONFIG.ai.maxInterval) {
    consecutiveProfileChanges = 0;
    return true;
  }
  if (lastProfileChange < CONFIG.ai.changeThreshold) {
    consecutiveProfileChanges = 0;
    return false;
  }
  consecutiveProfileChanges += 1;
  if (consecutiveProfileChanges < CONFIG.ai.stableChangePolls) return false;
  consecutiveProfileChanges = 0;
  return true;
}

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function cacheAIProfile(cacheKey, profile, meta) {
  if (aiProfileCache.has(cacheKey)) aiProfileCache.delete(cacheKey);
  aiProfileCache.set(cacheKey, { profile: cloneProfile(profile), meta: { ...meta } });
  while (aiProfileCache.size > CONFIG.ai.profileCacheSize) {
    aiProfileCache.delete(aiProfileCache.keys().next().value);
  }
}

function restoreCachedAIProfile(cacheKey, fingerprint) {
  const cached = aiProfileCache.get(cacheKey);
  if (!cached) return false;
  aiProfileCache.delete(cacheKey);
  aiProfileCache.set(cacheKey, cached);
  musicProfile = cloneProfile(cached.profile);
  aiProfileMeta = { ...cached.meta, cache: "local", latencyMs: 0 };
  aiProfileLoaded = true;
  keywordMatrixReady = true;
  aiProfileStatus = "ready";
  lastAIAnalysisTime = Date.now();
  lastAIFingerprint = fingerprint;
  lastProfileChange = 0;
  console.log("[AI] reused local profile", {
    genre: musicProfile.genreProfile.primary,
    cacheKey
  });
  return true;
}

async function buildMusicProfile({ force = false } = {}) {
  if (!audioStarted || aiAnalysisRunning || (!CONFIG.semantic.useLLM && !force)) return;

  if (audioAnalysis.samples < CONFIG.ai.minimumSamples) {
    aiProfileStatus = "collecting";
    scheduleAIAnalysis(CONFIG.ai.pollInterval);
    return;
  }

  const fingerprint = getCurrentFeatureFingerprint();
  if (!shouldRequestAIProfile(fingerprint, force)) {
    aiProfileStatus = aiProfileLoaded ? "ready" : "collecting";
    scheduleAIAnalysis(CONFIG.ai.pollInterval);
    return;
  }

  const cacheKey = CostControl.fingerprintKey(fingerprint, CONFIG.ai.cacheQuantization);
  if (!force && restoreCachedAIProfile(cacheKey, fingerprint)) {
    scheduleAIAnalysis(CONFIG.ai.pollInterval);
    return;
  }

  aiAnalysisRunning = true;
  aiProfileStatus = "analyzing";
  aiAbortController = new AbortController();
  const timeout = setTimeout(() => aiAbortController.abort(), CONFIG.ai.requestTimeout);

  try {
    const response = await fetch("/api/music-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featurePacket: createAudioAIFeaturePacket() }),
      signal: aiAbortController.signal
    });

    if (!response.ok) {
      const rawError = await response.text();
      let details = null;
      try {
        details = JSON.parse(rawError);
      } catch {
        details = { message: rawError };
      }
      console.error("[AI] server response", {
        status: response.status,
        buildVersion: details.buildVersion || response.headers.get("X-Music-Shower-Build"),
        code: details.code,
        message: details.message,
        usage: details.usage
      });
      const requestError = new Error(
        `HTTP ${response.status} · ${details.code || details.message || "AI request failed"}`
      );
      requestError.details = details;
      throw requestError;
    }
    const payload = await response.json();
    const nextProfile = validateMusicProfile(payload.profile);

    musicProfile = nextProfile;
    aiProfileMeta = payload.meta || null;
    aiProfileLoaded = true;
    aiFailureCount = 0;
    aiProfileErrorMessage = "";
    keywordMatrixReady = true;
    aiProfileStatus = "ready";
    lastAIAnalysisTime = Date.now();
    lastAIFingerprint = fingerprint;
    cacheAIProfile(cacheKey, musicProfile, aiProfileMeta);
    console.log("[AI] profile updated", {
      genre: musicProfile.genreProfile.primary,
      confidence: musicProfile.genreProfile.confidence,
      change: lastProfileChange,
      meta: aiProfileMeta
    });
  } catch (error) {
    aiFailureCount += 1;
    aiProfileErrorMessage = String(
      error.details?.code || error.details?.message || error.message || "unknown"
    ).slice(0, 80);
    if (error.name !== "AbortError") console.error("[AI] analysis failed:", error.message, error);
    aiProfileStatus = error.name === "AbortError" && !audioStarted ? "waiting" : "error";
  } finally {
    clearTimeout(timeout);
    aiAbortController = null;
    aiAnalysisRunning = false;
    if (audioStarted && CONFIG.semantic.useLLM && CONFIG.ai.autoEnrich) {
      const retryDelay = Math.min(
        CONFIG.ai.retryDelay * Math.pow(2, Math.max(0, aiFailureCount - 1)),
        CONFIG.ai.maxRetryDelay
      );
      scheduleAIAnalysis(aiProfileStatus === "error" ? retryDelay : CONFIG.ai.pollInterval);
    }
  }
}

function validateMusicProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("AI profile is missing.");
  if (!profile.genreProfile || !profile.instrumentationProfile || !profile.moodProfile || !profile.visualProfile) {
    throw new Error("AI profile sections are incomplete.");
  }
  if (!Array.isArray(profile.words) || profile.words.length < 8) {
    throw new Error("AI word bank is incomplete.");
  }

  const uniqueWords = new Map();
  for (const source of profile.words) {
    const text = String(source.text || "").trim().slice(0, 18);
    if (!text || uniqueWords.has(text)) continue;
    const derivedVisual = getVisualProfile(text, profile.visualProfile);
    uniqueWords.set(text, {
      text,
      category: source.category || "mood",
      weight: SignalMath.clamp(source.weight, 0.05, 1),
      hue: SignalMath.clamp(source.hue ?? derivedVisual.hue, 0, 360),
      saturation: SignalMath.clamp(source.saturation ?? derivedVisual.saturation),
      brightness: SignalMath.clamp(source.brightness ?? derivedVisual.brightness, 0.2, 1.5),
      glow: SignalMath.clamp(source.glow ?? derivedVisual.glow, 0.2, 2.5),
      speed: SignalMath.clamp(source.speed ?? derivedVisual.speed, 0.25, 2.2),
      scale: SignalMath.clamp(source.scale ?? derivedVisual.scale, 0.65, 1.5)
    });
  }
  profile.words = [...uniqueWords.values()];

  profile.genreProfile.confidence = SignalMath.clamp(profile.genreProfile.confidence);
  profile.genreProfile.secondary = (profile.genreProfile.secondary || []).map(candidate => ({
    name: String(candidate.name || "unknown"),
    confidence: SignalMath.clamp(candidate.confidence),
    evidence: String(candidate.evidence || "제한된 DSP 증거")
  }));
  profile.genreProfile.characteristics = [...new Set(
    (profile.genreProfile.characteristics || []).map(String)
  )].slice(0, 7);

  profile.instrumentationProfile.prominent = (profile.instrumentationProfile.prominent || [])
    .map(item => ({
      name: String(item.name || "미확정"),
      family: String(item.family || "unknown"),
      role: String(item.role || "texture"),
      confidence: SignalMath.clamp(item.confidence),
      evidence: String(item.evidence || "제한된 DSP 증거")
    }))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 6);
  profile.instrumentationProfile.textures = [...new Set(
    (profile.instrumentationProfile.textures || []).map(String)
  )].slice(0, 7);
  profile.instrumentationProfile.confidence = SignalMath.clamp(
    profile.instrumentationProfile.confidence
  );

  for (const key of ["valence", "arousal", "tension", "warmth", "spaciousness"]) {
    profile.moodProfile[key] = SignalMath.clamp(profile.moodProfile[key]);
  }
  profile.moodProfile.labels = [...new Set((profile.moodProfile.labels || []).map(String))].slice(0, 7);

  profile.visualProfile.primaryHue = SignalMath.clamp(profile.visualProfile.primaryHue, 0, 360);
  profile.visualProfile.secondaryHue = SignalMath.clamp(profile.visualProfile.secondaryHue, 0, 360);
  for (const key of ["saturation", "brightness", "pulse", "turbulence", "density"]) {
    profile.visualProfile[key] = SignalMath.clamp(profile.visualProfile[key]);
  }
  profile.intensity = SignalMath.clamp(profile.intensity);
  return profile;
}

function getMusicProfileWords() {
  const state = getSemanticState();
  return state.words || [];
}

function getRealtimeInstrumentWords() {
  if (!audioStarted || audioAnalysis.samples < Math.floor(CONFIG.ai.minimumSamples * 0.55)) return [];
  const styles = {
    bassline: { text: "베이스라인", hue: 205, saturation: 0.82, brightness: 0.78, glow: 1.25, speed: 0.82, scale: 1.12 },
    pianoKeys: { text: "피아노·건반", hue: 42, saturation: 0.5, brightness: 1.18, glow: 1.05, speed: 1.15, scale: 1.05 },
    synthPad: { text: "신스 패드", hue: 282, saturation: 0.7, brightness: 1.02, glow: 2.1, speed: 0.48, scale: 1.16 },
    percussion: { text: "드럼·퍼커션", hue: 12, saturation: 0.88, brightness: 1.16, glow: 1.35, speed: 1.55, scale: 1.02 }
  };
  return getInstrumentEvidenceProfile().candidates
    .filter(candidate => candidate.score >= CONFIG.ai.instrumentCandidateThreshold)
    .slice(0, 2)
    .map(candidate => ({
      category: "instrument",
      weight: SignalMath.clamp(candidate.score * 1.08, 0.05, 1),
      ...styles[candidate.id]
    }));
}

function getActiveInstrumentationLabels() {
  const labels = getSemanticState().instruments.map(item => item.label);
  for (const item of CONFIG.semantic.useLLM && aiProfileLoaded ? musicProfile.instrumentationProfile?.prominent || [] : []) {
    if (item.confidence >= 0.42 && item.name && !labels.includes(item.name)) labels.push(item.name);
  }
  for (const item of getRealtimeInstrumentWords()) {
    if (!labels.includes(item.text)) labels.push(item.text);
  }
  return labels;
}

function getActiveVisualProfile() {
  return getSemanticState().visual || musicProfile.visualProfile || createFallbackProfile().visualProfile;
}

function getActiveMoodProfile() {
  return getSemanticState().mood?.fused || musicProfile.moodProfile || createFallbackProfile().moodProfile;
}

function getActiveIntensity() {
  const state = getSemanticState();
  return SignalMath.clamp(
    (state.mood?.fused?.arousal || 0) * 0.58 +
    (state.audio?.energy || 0) * 0.3 +
    (state.audio?.beatConfidence || 0) * 0.12
  );
}

// Backwards-compatible manual refresh hook.
function buildKeywordMatrix() {
  return buildMusicProfile({ force: true });
}
