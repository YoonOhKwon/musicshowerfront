let lastWordSpawnTime = 0;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  // p5 may attach a global-mode canvas to the first page container. Keep the
  // visualization independent so the launcher's transform/hidden state never
  // moves or hides the canvas with it.
  canvas.parent(document.body);
  canvas.attribute("aria-label", "음악 특징에 반응하는 실시간 공감각 시각화");
  textAlign(CENTER, CENTER);
  initializeBackground();
  initializeSemanticRuntime();

  document.getElementById("startButton")?.addEventListener("click", startAudioCapture);
  document.getElementById("fileButton")?.addEventListener("click", () => {
    document.getElementById("audioFileInput")?.click();
  });
  document.getElementById("audioFileInput")?.addEventListener("change", event => {
    const [file] = event.target.files || [];
    if (file) startAudioFile(file);
    event.target.value = "";
  });
  document.getElementById("stopButton")?.addEventListener("click", () => stopAudioCapture());
  const qualitySelect = document.getElementById("qualityMode");
  if (qualitySelect) {
    qualitySelect.value = CONFIG.ml.quality;
    qualitySelect.addEventListener("change", event => {
      const url = new URL(location.href);
      url.searchParams.set("quality", event.target.value);
      location.assign(url);
    });
  }
  const languageSelect = document.getElementById("languageMode");
  if (languageSelect) {
    languageSelect.value = CONFIG.language.remote.enabled ? "remote" : "local";
    languageSelect.addEventListener("change", event => {
      const url = new URL(location.href);
      url.searchParams.set("language", event.target.value);
      location.assign(url);
    });
  }
  window.addEventListener("pagehide", () => releaseAudioResources());
}

// Periodic direct-audio (Music Flamingo) capture. Unlike the first version of this feature, a
// caption never goes straight to the screen: it becomes candidate observations
// (lib/directAudioReview.js's toObservations(), server-side) fed into the SAME evidence-fusion /
// temporal-stability pipeline every other source uses (js/semantic/semanticEngine.js's
// applyDirectAudioObservations() -> updateTemporalEvidence()) -- it earns its confidence there,
// same as a classifier or DSP read, rather than being handed a shortcut. First capture at 30s (the
// same point genre/context language is already opening up); re-captured every 45s afterward so the
// evidence genuinely tracks a "still listening" cadence instead of a one-shot snapshot.
const deepListenState = { active: false, lastTriggeredAt: 0 };

function updateWordSpawner() {
  if (!audioStarted) return;
  const now = millis();

  if (!deepListenState.active && typeof mlAudioWindow !== "undefined" && mlAudioWindow) {
    const sessionMs = performance.now() - (pcmCaptureMetrics?.startedAt || performance.now());
    const dueAt = deepListenState.lastTriggeredAt ? deepListenState.lastTriggeredAt + 45000 : 30000;
    if (sessionMs > dueAt) { deepListenState.lastTriggeredAt = sessionMs; triggerDeepAnalysisUpload(); }
  }

  const arousal = getActiveMoodProfile().arousal || 0.5;
  const densityFactor = WordLifecycle.densityFactor(floatingWords.length, CONFIG.visual.maxFloatingWords);
  const interval = CONFIG.visual.wordSpawnInterval * (1.18 - arousal * 0.38) * densityFactor;

  if (lastWordSpawnTime === 0 || now - lastWordSpawnTime >= interval) {
    let spawned = false;
    beginWordSpawnBatch();
    for (let index = 0; index < CONFIG.visual.wordsPerSpawn; index++) spawned = createWord() || spawned;
    if (spawned) lastWordSpawnTime = now;
  }
}

function pcmToWav(pcm, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, string) => { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); };
  writeString(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); writeString(8, "WAVE");
  writeString(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0, offset = 44; i < pcm.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function triggerDeepAnalysisUpload() {
  if (!mlAudioWindow) return;
  const pcm = mlAudioWindow.latestNative(30);
  if (!pcm || pcm.length < audioContext.sampleRate * 5) return;
  deepListenState.active = true;
  const buffer = pcmToWav(pcm, audioContext.sampleRate);
  console.log("[Deep Listen] capturing 30s and uploading to /api/deep-analysis...");
  fetch("/api/deep-analysis", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: buffer })
    .then(res => res.json())
    .then(data => {
      if (data.error) { console.error("[Deep Listen] server reported an error:", data.error); return; }
      console.log("[Deep Listen] caption:", data.caption);
      console.log(`[Deep Listen] ${data.observations?.length || 0} observation(s) ->`, data.observations);
      if (Array.isArray(data.observations)) applyDirectAudioObservations(data.observations);
    })
    .catch(error => console.error("[Deep Listen] request failed (is flamingo_server.py running on :5005?):", error))
    .finally(() => { deepListenState.active = false; });
}

function draw() {
  if (audioStarted) {
    updateAudioData();
    updateBeatDetection();
    updateSemanticRuntime(performance.now());
    updateWordSpawner();
    if (ReplayRecorder.isActive()) ReplayRecorder.capture(getSemanticState(), performance.now());
  }
  drawBackground();
  updateVisuals();
  if (audioStarted && CONFIG.semantic.debug) {
    drawHUD();
    drawAIStatus();
    drawSemanticHUD();
    drawSemanticDebugPanel();
    drawReplayRecorderStatus();
  }
}

// STEP 3: recording status line, drawn only while the debug panel (D) is open -- kept separate
// from drawSemanticDebugPanel()'s single multi-line text() call so toggling recording never
// touches that function's existing line layout.
function drawReplayRecorderStatus() {
  push();
  textAlign(LEFT, TOP);
  textFont("monospace");
  textSize(12);
  fill(ReplayRecorder.isActive() ? [255, 120, 120, 230] : [160, 180, 200, 190]);
  const label = ReplayRecorder.isActive()
    ? `● REC "${ReplayRecorder.snapshot().track}"  ${ReplayRecorder.frameCount()} frames  (R to stop + download)`
    : "○ not recording  (R to start a replay-harness recording)";
  text(label, 32, 574);
  pop();
}

function drawAIStatus() {
  if (!audioStarted) return;
  const state = getSemanticState();
  const labels = {
    idle: "음악 대기 중",
    collecting: `오디오 분석 중 ${Math.min(100, Math.round((audioAnalysis.samples / CONFIG.ai.minimumSamples) * 100))}%`,
    interpreting: "로컬 음악 해석 중",
    loading: "음악 모델 로딩 중",
    fallback: "로컬 DSP 분석",
    uncertain: "불확실한 장르 · 로컬 분석",
    ready: "음악 모델 준비 완료"
  };
  push();
  textAlign(RIGHT, TOP);
  textSize(12);
  textFont("Arial");
  fill(255, 255, 255, 145);
  text(labels[state.status] || labels[state.ml.status] || "로컬 분석 준비", width - 24, 24);
  pop();
}

function keyPressed() {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (key === "d" || key === "D") {
    CONFIG.semantic.debug = !CONFIG.semantic.debug;
    document.body.classList.toggle("semanticDebug", CONFIG.semantic.debug);
  }
  if (key === "l" || key === "L") LanguageInspector.toggle();
  // STEP 3: only reachable with the debug panel open, matching where its status line renders.
  if ((key === "r" || key === "R") && CONFIG.semantic.debug) {
    if (ReplayRecorder.isActive()) {
      ReplayRecorder.download(ReplayRecorder.stop());
    } else {
      const name = window.prompt("Replay recording name (e.g. future_funk_01):", `recording_${Date.now()}`);
      if (name) ReplayRecorder.start(name);
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initializeBackground();
}
