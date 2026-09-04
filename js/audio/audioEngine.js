let audioContext = null;
let sourceNode = null;
let analyser = null;
let meydaFeatureWorker = null;
let meydaWorkerBusy = false;
let meydaFallbackWarned = false;
let audioFrequencyData = null;
let audioWaveformData = null;
let mlTimeDomainFrame = null;
let mlAudioWindow = null;
let pcmCaptureNode = null;
let pcmSilentGain = null;
let captureStream = null;
let fileAudioElement = null;
let fileObjectUrl = null;
let audioStarted = false;
let audioInputMode = "idle";
let pcmCaptureMetrics = { messages: 0, samples: 0, blockSize: 0, startedAt: 0, lastAt: 0, rms: 0, peak: 0, bands: {}, processingMs: 0, transport: "transferable" };

function setAudioStatus(message, state = "info") {
  const element = document.getElementById("audioStatus");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

function setAudioControlsRunning(running) {
  const launcher = document.getElementById("audioLauncher");
  const stopButton = document.getElementById("stopButton");
  if (launcher) launcher.hidden = running;
  if (stopButton) stopButton.hidden = !running;
}

function createAudioContext() {
  return new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
}

const MEYDA_FEATURE_EXTRACTORS = [
  "chroma", "mfcc", "rms", "energy", "zcr", "loudness",
  "spectralCentroid", "spectralFlatness", "spectralRolloff", "spectralSpread",
  "spectralSkewness", "spectralKurtosis", "spectralCrest",
  "perceptualSharpness", "perceptualSpread"
];

function analyzeMeydaFallback(samples) {
  try {
    const seconds = CONFIG.audio.meydaBufferSize / audioContext.sampleRate;
    const source = samples?.length ? samples : mlAudioWindow?.latestNative(seconds);
    if (!source?.length || source.length < CONFIG.audio.meydaBufferSize || !window.Meyda?.extract) return;
    const frame = source.length === CONFIG.audio.meydaBufferSize
      ? source : source.subarray(source.length - CONFIG.audio.meydaBufferSize);
    Meyda.sampleRate = audioContext.sampleRate;
    Meyda.bufferSize = CONFIG.audio.meydaBufferSize;
    Meyda.numberOfMFCCCoefficients = CONFIG.audio.mfccCoefficients;
    processMeydaFeatures(Meyda.extract(MEYDA_FEATURE_EXTRACTORS, frame));
  } catch (error) {
    if (!meydaFallbackWarned) console.warn("Meyda feature extraction unavailable:", error.message || error);
    meydaFallbackWarned = true;
  }
}

function dispatchMeydaAnalysis(samples) {
  if (!meydaFeatureWorker) return analyzeMeydaFallback(samples);
  if (meydaWorkerBusy) return;
  meydaWorkerBusy = true;
  if (samples?.length && !mlAudioWindow.shared) {
    meydaFeatureWorker.postMessage({ type: "analyze", samples }, [samples.buffer]);
  } else {
    meydaFeatureWorker.postMessage({ type: "analyze" });
  }
}

function startMeydaFeatureWorker() {
  try {
    meydaFeatureWorker = new Worker("./js/audio/meydaFeatureWorker.js");
    meydaFeatureWorker.onmessage = event => {
      const message = event.data || {};
      meydaWorkerBusy = false;
      if (message.type === "features") processMeydaFeatures(message.features);
      if (message.type === "failed") {
        console.warn("Meyda Worker unavailable; using bounded main-thread extraction:", message.error);
        meydaFeatureWorker?.terminate();
        meydaFeatureWorker = null;
      }
    };
    meydaFeatureWorker.onerror = event => {
      meydaWorkerBusy = false;
      console.warn("Meyda Worker failed; using bounded main-thread extraction:", event.message || "worker error");
      meydaFeatureWorker?.terminate();
      meydaFeatureWorker = null;
    };
    meydaFeatureWorker.postMessage({
      type: "init",
      sampleRate: audioContext.sampleRate,
      bufferSize: CONFIG.audio.meydaBufferSize,
      mfccCoefficients: CONFIG.audio.mfccCoefficients,
      sharedRing: mlAudioWindow.shared ? mlAudioWindow.descriptor() : null
    });
  } catch (error) {
    console.warn("Meyda Worker could not start; using bounded main-thread extraction:", error.message || error);
    meydaFeatureWorker = null;
  }
}

async function configureAudioGraph(node, { monitor = false, mode = "display" } = {}) {
  sourceNode = node;
  analyser = audioContext.createAnalyser();
  analyser.fftSize = CONFIG.audio.fftSize;
  analyser.smoothingTimeConstant = CONFIG.audio.smoothing;
  sourceNode.connect(analyser);
  if (monitor) sourceNode.connect(audioContext.destination);

  audioFrequencyData = new Uint8Array(analyser.frequencyBinCount);
  audioWaveformData = new Uint8Array(analyser.fftSize);
  mlAudioWindow = SharedAudioRing.create(audioContext.sampleRate,
    CONFIG.ml.windows.long + CONFIG.audio.sharedRingSecondsMargin) ||
    new AudioWindowBuffer(audioContext.sampleRate, CONFIG.ml.windows.long + CONFIG.audio.sharedRingSecondsMargin);
  await audioContext.audioWorklet.addModule("./js/audio/pcmCaptureProcessor.js");
  pcmCaptureNode = new AudioWorkletNode(audioContext, "music-shower-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      blockSize: CONFIG.audio.pcmBlockSize,
      sharedRing: mlAudioWindow.shared ? mlAudioWindow.descriptor() : null
    }
  });
  pcmSilentGain = audioContext.createGain();
  pcmSilentGain.gain.value = 0;
  pcmCaptureMetrics = {
    messages: 0,
    samples: 0,
    blockSize: CONFIG.audio.pcmBlockSize,
    startedAt: performance.now(),
    lastAt: performance.now(),
    rms: 0,
    peak: 0,
    bands: {},
    processingMs: 0,
    transport: mlAudioWindow.shared ? "shared-ring" : "transferable"
  };
  startMeydaFeatureWorker();
  pcmCaptureNode.port.onmessage = event => {
    const packet = event.data || {};
    const samples = packet.type === "pcm" ? packet.samples : null;
    if (packet.type === "pcm" && samples?.length && !mlAudioWindow.shared) mlAudioWindow?.push(samples);
    if (packet.type !== "pcm" && packet.type !== "metrics") return;
    pcmCaptureMetrics.messages += 1;
    pcmCaptureMetrics.samples += packet.blockSize || samples?.length || 0;
    pcmCaptureMetrics.blockSize = packet.blockSize || samples?.length || 0;
    pcmCaptureMetrics.rms = Number(packet.rms) || 0;
    pcmCaptureMetrics.peak = Number(packet.peak) || 0;
    pcmCaptureMetrics.bands = packet.bands || {};
    pcmCaptureMetrics.processingMs = Number(packet.processingMs) || 0;
    RuntimePerformance?.recordAudioWorklet?.(pcmCaptureMetrics.processingMs);
    pcmCaptureMetrics.lastAt = performance.now();
    dispatchMeydaAnalysis(samples);
  };
  if (mlAudioWindow.shared) musicModelBridge?.attachSharedRing(mlAudioWindow.descriptor());
  sourceNode.connect(pcmCaptureNode);
  pcmCaptureNode.connect(pcmSilentGain);
  pcmSilentGain.connect(audioContext.destination);
  resetAudioAnalysis();
  resetBeatDetection();

  audioStarted = true;
  audioInputMode = mode;
  beginSemanticSession(mode);
  lastWordSpawnTime = 0;
  setAudioControlsRunning(true);
  setAudioStatus(mode === "file" ? "음원 파일 분석 중" : "탭/시스템 오디오 분석 중", "active");
  startAIAnalysisLoop();
}

async function startAudioCapture() {
  if (audioStarted) return;
  const button = document.getElementById("startButton");

  try {
    if (button) button.disabled = true;
    setAudioStatus("공유할 탭을 선택하고 ‘오디오 공유’를 켜 주세요.", "waiting");

    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      surfaceSwitching: "include"
    });

    captureStream.getVideoTracks().forEach(track => track.stop());
    const [audioTrack] = captureStream.getAudioTracks();
    if (!audioTrack) {
      captureStream.getTracks().forEach(track => track.stop());
      captureStream = null;
      throw new Error("선택한 화면에서 오디오 트랙을 받을 수 없습니다.");
    }

    audioTrack.addEventListener("ended", () => stopAudioCapture("오디오 공유가 종료되었습니다."), {
      once: true
    });

    audioContext = createAudioContext();
    await audioContext.resume();
    await configureAudioGraph(audioContext.createMediaStreamSource(captureStream), {
      monitor: false,
      mode: "display"
    });
  } catch (error) {
    console.error("Audio capture failed:", error);
    await releaseAudioResources();
    setAudioControlsRunning(false);
    setAudioStatus(
      error?.name === "NotAllowedError"
        ? "오디오 공유가 취소되었습니다. 다시 시도하거나 파일을 선택하세요."
        : error.message || "오디오 입력을 시작하지 못했습니다.",
      "error"
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function startAudioFile(file) {
  if (!file) return;
  if (audioStarted) await stopAudioCapture("새 음원으로 전환합니다.");

  try {
    setAudioStatus("음원 파일을 준비하는 중…", "waiting");
    audioContext = createAudioContext();
    await audioContext.resume();

    fileObjectUrl = URL.createObjectURL(file);
    fileAudioElement = new Audio(fileObjectUrl);
    fileAudioElement.preload = "auto";
    fileAudioElement.crossOrigin = "anonymous";
    fileAudioElement.addEventListener("ended", () => stopAudioCapture("음원 재생이 완료되었습니다."), {
      once: true
    });

    const mediaSource = audioContext.createMediaElementSource(fileAudioElement);
    await configureAudioGraph(mediaSource, { monitor: true, mode: "file" });
    await fileAudioElement.play();
  } catch (error) {
    console.error("Audio file failed:", error);
    await releaseAudioResources();
    setAudioControlsRunning(false);
    setAudioStatus(error.message || "음원 파일을 재생하지 못했습니다.", "error");
  }
}

function updateAudioData() {
  if (!analyser || !audioFrequencyData || !audioWaveformData) return;
  analyser.getByteFrequencyData(audioFrequencyData);
  analyser.getByteTimeDomainData(audioWaveformData);
  updateRealtimeSpectrumAnalysis();
}

function getMLAudioWindow(seconds) {
  return mlAudioWindow?.latestNative(seconds) || new Float32Array();
}

function getAudioCaptureDebugState() {
  const elapsed = Math.max(0.001, ((pcmCaptureMetrics.lastAt || performance.now()) - pcmCaptureMetrics.startedAt) / 1000);
  return {
    messageRate: pcmCaptureMetrics.messages / elapsed,
    blockSize: pcmCaptureMetrics.blockSize,
    messages: pcmCaptureMetrics.messages,
    bufferedSeconds: mlAudioWindow && audioContext ? mlAudioWindow.count / audioContext.sampleRate : 0,
    rms: pcmCaptureMetrics.rms,
    peak: pcmCaptureMetrics.peak,
    bands: pcmCaptureMetrics.bands,
    processingMs: pcmCaptureMetrics.processingMs,
    transport: pcmCaptureMetrics.transport
  };
}

async function releaseAudioResources() {
  stopAIAnalysisLoop();
  endSemanticSession();

  meydaFeatureWorker?.terminate();
  meydaFeatureWorker = null;
  meydaWorkerBusy = false;

  captureStream?.getTracks().forEach(track => track.stop());
  captureStream = null;

  if (fileAudioElement) {
    fileAudioElement.pause();
    fileAudioElement.removeAttribute("src");
    fileAudioElement.load();
  }
  fileAudioElement = null;

  if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl);
  fileObjectUrl = null;

  try {
    sourceNode?.disconnect();
  } catch (error) {
    console.warn("Audio source disconnect failed:", error);
  }

  try {
    pcmCaptureNode?.disconnect();
    pcmSilentGain?.disconnect();
  } catch (error) {
    console.warn("PCM capture disconnect failed:", error);
  }

  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  audioContext = null;
  sourceNode = null;
  analyser = null;
  meydaFallbackWarned = false;
  audioFrequencyData = null;
  audioWaveformData = null;
  mlAudioWindow = null;
  pcmCaptureNode = null;
  pcmSilentGain = null;
  audioStarted = false;
  audioInputMode = "idle";
  pcmCaptureMetrics = { messages: 0, samples: 0, blockSize: 0, startedAt: 0, lastAt: 0, rms: 0, peak: 0, bands: {}, processingMs: 0, transport: "transferable" };
}

async function stopAudioCapture(message = "분석을 중지했습니다.") {
  await releaseAudioResources();
  setAudioControlsRunning(false);
  setAudioStatus(message, "info");
}
