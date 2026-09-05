let floatingWords = [];
let recentWordTexts = [];
let recentWordTokens = [];
let spawnBatchFacets = new Set();

function beginWordSpawnBatch() {
  spawnBatchFacets.clear();
}

function selectWeightedWord() {
  const state = getSemanticState();
  const evidenceReadiness = PhraseSelection.evidenceReadinessOf(state.genreReasoning?.primary);
  return PhraseSelection.choose(getMusicProfileWords(), recentWordTokens, () => random(), {
    changing: state.expressionFeatures?.changing,
    observationSeconds: state.expressionFeatures?.observationSeconds ?? (state.temporalEvidence?.elapsedMs || 0) / 1000,
    evidenceReadiness,
    active: floatingWords.map(word => word.text),
    avoidFacets: [...spawnBatchFacets]
  });
}

function createWord() {
  if (!audioStarted || !WordLifecycle.canSpawn(floatingWords.length, CONFIG.visual.maxFloatingWords)) return false;
  const selected = selectWeightedWord();
  if (!selected) return false;
  recentWordTexts.push(selected.text);
  if (recentWordTexts.length > CONFIG.visual.recentWordMemory) recentWordTexts.shift();
  recentWordTokens.push(selected);
  if (recentWordTokens.length > CONFIG.visual.recentWordMemory) recentWordTokens.shift();
  noteSemanticPhraseUsed(selected.text);
  spawnBatchFacets.add(PhraseQuality.musicalFacet(selected));
  floatingWords.push(new FloatingWord(selected, floatingWords));
  return true;
}

function drawHUD() {
  push();
  textAlign(LEFT, TOP);
  textSize(12);
  textFont("Arial");
  fill(255, 255, 255, 145);
  text(`ENERGY  ${Math.round(smoothEnergy * 100)}%`, 24, 24);
  text(`BASS    ${Math.round(smoothBass)}`, 24, 43);
  text(`MID     ${Math.round(smoothMid)}`, 24, 62);
  text(`HIGH    ${Math.round(smoothHigh)}`, 24, 81);
  text(`BPM     ${bpm ? Math.round(bpm) : "--"}`, 24, 100);
  text(`LOCK    ${Math.round(bpmConfidence * 100)}%`, 24, 119);
  pop();
}

function drawSemanticHUD() {
  if (!audioStarted) return;
  const state = getSemanticState();
  const genre = state.genre;
  const mood = state.mood.fused;
  const moods = [
    mood.arousal > 0.62 ? "에너지" : mood.arousal < 0.35 ? "차분" : "유영",
    mood.brightness > 0.6 ? "밝음" : mood.brightness < 0.38 ? "어두움" : "중성",
    mood.tension > 0.58 ? "긴장" : "안정",
    mood.spaciousness > 0.6 ? "공간감" : "밀도감"
  ];
  const instruments = getActiveInstrumentationLabels();
  push();
  textAlign(RIGHT, TOP);
  textFont("Arial");
  fill(255, 255, 255, 205);
  textStyle(BOLD);
  textSize(17);
  text(genre.displayLabel || (genre.uncertain ? "미확정 장르" : genre.primary), width - 24, 52);
  textStyle(NORMAL);
  textSize(12);
  fill(255, 255, 255, 130);
  text(`${genre.family || ""} · 보정 신뢰도 ${Math.round((genre.confidence || 0) * 100)}%`, width - 24, 76);
  text(moods.slice(0, 4).join("  ·  "), width - 24, 96);
  if (instruments.length) {
    fill(185, 225, 255, 155);
    text(instruments.slice(0, 3).join("  ·  "), width - 24, 116);
  }
  if (state.ml.inferenceLatency) {
    fill(255, 255, 255, 110);
    text(`${state.ml.backend} · ${(state.ml.inferenceLatency / 1000).toFixed(2)}s`, width - 24, 136);
  }
  pop();
}

function drawSemanticDebugPanel() {
  if (!audioStarted || !CONFIG.semantic.debug) return;
  const state = getSemanticState();
  const backgroundState = getBackgroundDebugState();
  const captureState = typeof getAudioCaptureDebugState === "function" ? getAudioCaptureDebugState() : {};
  const timings = state.ml.timings || {};
  const character = state.trackCharacter || {};
  const performanceState = RuntimePerformance.snapshot();
  const lines = [
    `FPS ${Math.round(frameRate())}`,
    `DSP rms ${state.audio.rms.toFixed(3)}  flux ${state.audio.flux.toFixed(4)}  centroid ${Math.round(state.audio.centroid)}Hz`,
    `BPM ${state.audio.bpm ? Math.round(state.audio.bpm) : "--"}  lock ${Math.round(state.audio.beatConfidence * 100)}%`,
    `WORKLET ${captureState.transport || "transferable"} ${captureState.messageRate?.toFixed(1) || "0.0"}/s  block ${captureState.blockSize || 0}  ${(performanceState.audioWorkletP90Ms || 0).toFixed(2)}ms p90`,
    `ML ${state.ml.status}  backend ${state.ml.backend}  ${Math.round(state.ml.inferenceLatency)}ms  model ${state.ml.bundledModelMB ? state.ml.bundledModelMB.toFixed(1) : "--"}MB  mode ${CONFIG.ml.quality}`,
    `ML resample ${Math.round(timings.resampleMs || 0)}  mel ${Math.round(timings.melMs || 0)}  encoder ${Math.round(timings.encoderMs || 0)}ms`,
    `ML heads I ${Math.round(timings.instrumentMs || 0)}  M ${Math.round(timings.moodMs || 0)}  roundtrip ${Math.round(timings.roundTripMs || 0)}ms`,
    `MAIN transfer ${Math.round(timings.transferDispatchMs || 0)}ms  long ${Math.round(performanceState.longTaskP90Ms || 0)}ms  MIR ${(performanceState.mirP90Ms || 0).toFixed(2)}ms  SEM ${(performanceState.semanticP90Ms || 0).toFixed(2)}ms  heap ${performanceState.memoryMB ? performanceState.memoryMB.toFixed(0) : "--"}MB`,
    state.ml.error ? `ML error ${state.ml.error}` : "ML error --",
    `GENRE ${state.genre.primary}  calibrated ${Math.round(state.genre.confidence * 100)}%  raw ${Math.round((state.genre.rawConfidence || 0) * 100)}%`,
    `certainty ${state.genre.certainty || "unknown"}  stability ${state.genre.stability.toFixed(2)}  agreement ${(state.genre.temporalAgreement || 0).toFixed(2)}`,
    `novelty ${state.novelty.score.toFixed(2)}  transition ${state.novelty.transitionDetected ? "YES" : "no"}`,
    `epoch ${state.semanticEpoch || 0}  change ${(state.semanticChange?.score || 0).toFixed(2)}  phrases ${state.language?.phraseCount || 0}`,
    `V2 stable ${state.stateV2?.temporal?.stable?.length || 0}  memory ${state.stateV2?.temporal?.trackMemory?.length || 0}  fused genre ${(state.temporalEvidence?.evaluated || []).filter(item => item.category === "genre").slice(0, 3).map(item => `${item.text} ${Math.round(item.confidence * 100)}%(${Array.isArray(item.source) ? item.source.join("+") : String(item.source || "")})`).join(" · ") || "--"}`,
    `character rhythm ${(character.rhythm?.rhythmicComplexity || 0).toFixed(2)}  tonal ${(character.harmony?.tonalness || 0).toFixed(2)}  rough ${(character.timbre?.roughness || 0).toFixed(2)}`,
    `instrument ${state.instruments.slice(0, 3).map(item => `${item.label} ${Math.round(item.confidence * 100)}%`).join(" · ") || "--"}`,
    `mood A ${state.mood.fused.arousal.toFixed(2)}  V ${state.mood.fused.valence.toFixed(2)}  T ${state.mood.fused.tension.toFixed(2)}`,
    `zero-shot ${state.zeroShot.available ? (state.zeroShot.active ? "active" : "idle") : "unavailable"}`,
    `LANG ${state.language?.provider || "fallback"} / ${state.language?.status || "fallback"}  ${Math.round(state.language?.generationLatency || 0)}ms · L: inspect`,
    `PHRASE ${(state.words || []).slice(0, 2).map(item => item.text).join(" | ") || "--"}`,
    `BG ${backgroundState.shader ? "shader" : "fallback"}/${backgroundState.quality || "--"}  heat ${(backgroundState.heat || 0).toFixed(2)}  turb ${(backgroundState.turbulence || 0).toFixed(2)}  render ${Math.round(backgroundState.renderMs || 0)}ms`
  ];
  push();
  rectMode(CORNER);
  noStroke();
  fill(5, 7, 18, 215);
  rect(18, 150, Math.min(800, width - 36), 416, 12);
  fill(210, 235, 255, 220);
  textAlign(LEFT, TOP);
  textFont("monospace");
  textSize(12);
  text(lines.join("\n"), 32, 165);
  pop();
}

function resetFloatingSemanticVisuals() {
  floatingWords.length = 0;
  recentWordTexts.length = 0;
  recentWordTokens.length = 0;
  spawnBatchFacets.clear();
  wordLaneCursor = 0;
  wordDirectionCursor = 0;
}

function updateVisuals() {
  for (let index = floatingWords.length - 1; index >= 0; index--) {
    const word = floatingWords[index];
    word.update();
    word.show();
    if (word.life <= 0) floatingWords.splice(index, 1);
  }

}
