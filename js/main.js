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

function updateWordSpawner() {
  if (!audioStarted) return;
  const now = millis();
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

function draw() {
  if (audioStarted) {
    updateAudioData();
    updateBeatDetection();
    updateSemanticRuntime(performance.now());
    updateWordSpawner();
  }
  drawBackground();
  updateVisuals();
  if (audioStarted && CONFIG.semantic.debug) {
    drawHUD();
    drawAIStatus();
    drawSemanticHUD();
    drawSemanticDebugPanel();
  }
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
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initializeBackground();
}
