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
let soundCloudExtensionAvailable = false;
let soundCloudExtensionVersion = "";
let soundCloudExtensionAttached = false;
let soundCloudSourceTabId = null;
let soundCloudLifecycleController = null;
let soundCloudTrack = null;
let soundCloudCurrentUrl = "";
let soundCloudPositionSeconds = 0;
let soundCloudDurationSeconds = 0;
let soundCloudReleasing = false;
let soundCloudConnectionId = "";
let soundCloudAttachStage = "idle";
let soundCloudAttachError = "";
let soundCloudAudioFlowReported = false;
let soundCloudPeerConnection = null;
let soundCloudAttachAttempt = 0;
let audioStarted = false;
let audioInputMode = "idle";
let pcmCaptureMetrics = { messages: 0, samples: 0, blockSize: 0, startedAt: 0, lastAt: 0, rms: 0, peak: 0, bands: {}, processingMs: 0, transport: "transferable" };
const EMBEDDED_CONTROL_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

function isAllowedEmbeddedParent(origin) {
  if (!origin) return false;
  if (origin === location.origin) return true;
  if (EMBEDDED_CONTROL_ORIGINS.has(origin)) return true;
  try {
    const extra = new URLSearchParams(location.search).get("parentOrigin");
    if (extra && new URL(extra).origin === origin) return true;
  } catch { /* ignore invalid parentOrigin */ }
  return false;
}

function postSoundCloudPageMessage(message) {
  window.postMessage(message, location.origin);
  if (window.parent === window) return;
  try {
    const parentOrigin = new URL(document.referrer).origin;
    if (isAllowedEmbeddedParent(parentOrigin)) window.parent.postMessage(message, parentOrigin);
  } catch { /* embedded relay is optional */ }
}

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

function setSoundCloudAnalysisButton(visible, label = "SoundCloud 분석 시작") {
  const button = document.getElementById("soundCloudAnalysisButton");
  if (!button) return;
  button.hidden = !visible;
  button.textContent = label;
}

async function resumeSoundCloudAnalysis() {
  if (soundCloudAudioFlowReported) return true;
  return startSoundCloudTabShare();
}

function dispatchSoundCloudTransport(event) {
  window.dispatchEvent(new CustomEvent("music-shower:soundcloud-transport", { detail: event }));
  updateSoundCloudDock();
}

function formatSoundCloudTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function updateSoundCloudDock() {
  const dock = document.getElementById("soundCloudDock");
  if (!dock) return;
  const snapshot = soundCloudLifecycleController?.snapshot();
  const connected = audioInputMode === "soundcloud" && soundCloudExtensionAttached;
  dock.hidden = !connected;
  if (!connected) return;
  const title = document.getElementById("soundCloudTrackTitle");
  const artist = document.getElementById("soundCloudTrackArtist");
  const source = document.getElementById("soundCloudTrackLink");
  const artwork = document.getElementById("soundCloudArtwork");
  const toggle = document.getElementById("soundCloudToggleButton");
  const timeline = document.getElementById("soundCloudTimeline");
  if (title) title.textContent = soundCloudTrack?.title || "SoundCloud 트랙";
  if (artist) artist.textContent = soundCloudTrack?.artist || "SoundCloud";
  if (source) {
    source.href = soundCloudTrack?.permalinkUrl || "https://soundcloud.com";
    source.hidden = !soundCloudTrack?.permalinkUrl;
  }
  if (artwork) {
    artwork.hidden = !soundCloudTrack?.artworkUrl;
    if (soundCloudTrack?.artworkUrl) artwork.src = soundCloudTrack.artworkUrl;
  }
  if (toggle) {
    const playing = snapshot?.transport === "playing";
    toggle.textContent = playing ? "일시정지" : snapshot?.transport === "ended" ? "다시 재생" : "이어 재생";
    toggle.setAttribute("aria-pressed", String(playing));
  }
  if (timeline) {
    timeline.textContent = soundCloudDurationSeconds > 0
      ? `${formatSoundCloudTime(soundCloudPositionSeconds)} / ${formatSoundCloudTime(soundCloudDurationSeconds)}`
      : formatSoundCloudTime(soundCloudPositionSeconds);
  }
}

function getSoundCloudPlaybackState() {
  const snapshot = soundCloudLifecycleController?.snapshot() || {
    connected: false, transport: "disconnected", track: null, lastEvent: null
  };
  return {
    ...snapshot,
    connected: soundCloudExtensionAttached,
    streamProtocol: "chrome-extension-tab-capture",
    attachStage: soundCloudAttachStage,
    attachError: soundCloudAttachError,
    audioContextState: audioContext?.state || "none",
    audioTrackState: captureStream?.getAudioTracks?.()[0]?.readyState || "none",
    audioFlowConfirmed: soundCloudAudioFlowReported
  };
}

function isCurrentSoundCloudExtension() {
  const [major = 0, minor = 0] = String(soundCloudExtensionVersion || "")
    .split(".")
    .map(value => Number(value) || 0);
  return soundCloudExtensionAvailable && (major > 1 || (major === 1 && minor >= 3));
}

function renderSoundCloudAvailability() {
  const status = document.getElementById("soundCloudConfigStatus");
  const button = document.getElementById("soundCloudConnectButton");
  const ready = isCurrentSoundCloudExtension();
  if (status) {
    status.textContent = ready
      ? `탭 연결 확장 프로그램 ${soundCloudExtensionVersion} 준비됨`
      : soundCloudExtensionAvailable
        ? "확장 프로그램 업데이트 필요 · chrome://extensions에서 새로고침하세요."
        : "chrome-extension 폴더를 Chrome에 먼저 설치하세요.";
    status.dataset.state = ready ? "ready" : "missing";
  }
  if (button) button.disabled = !ready;
  return ready;
}

async function refreshSoundCloudAvailability() {
  postSoundCloudPageMessage({ source: "music-shower-page", type: "SOUNDCLOUD_PING" });
  return renderSoundCloudAvailability();
}

function sendSoundCloudExtensionCommand(command, url = null) {
  postSoundCloudPageMessage({
    source: "music-shower-page",
    type: "SOUNDCLOUD_COMMAND",
    command,
    url
  });
}

function sendSoundCloudBridgeStatus(type, detail = {}) {
  postSoundCloudPageMessage({ source: "music-shower-page", type, ...detail });
}

function readableSoundCloudAttachError(error) {
  const name = String(error?.name || "Error");
  const message = String(error?.message || "SoundCloud 탭 오디오를 연결하지 못했습니다.");
  if (name === "NotAllowedError") return `Chrome가 탭 오디오 사용을 허용하지 않았습니다. (${name}: ${message})`;
  if (name === "NotReadableError") return `SoundCloud 탭 오디오를 읽을 수 없습니다. 탭을 새로고침해 주세요. (${name}: ${message})`;
  if (name === "AbortError") return `탭 오디오 연결이 중단되었습니다. (${name}: ${message})`;
  return `${name}: ${message}`;
}

async function resumeAudioContextWithoutBlocking(context, timeoutMs = 1500) {
  if (!context || context.state !== "suspended") return context?.state || "none";
  let timer = null;
  try {
    await Promise.race([
      context.resume(),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } catch (error) {
    console.warn("SoundCloud AudioContext resume deferred until the next page interaction:", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return context.state;
}

function waitForSoundCloudIceGathering(connection, timeoutMs = 2500) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      connection.removeEventListener("icegatheringstatechange", check);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    connection.addEventListener("icegatheringstatechange", check);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function receiveSoundCloudWebRtcStream(message) {
  const connection = new RTCPeerConnection({ iceServers: [] });
  soundCloudPeerConnection = connection;
  let timer = null;
  const streamPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    connection.addEventListener("track", event => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      finish(resolve, stream);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(connection.connectionState)) {
        finish(reject, new Error(`SoundCloud 내부 오디오 연결 상태: ${connection.connectionState}`));
      }
    });
    timer = setTimeout(() => finish(reject, new Error("SoundCloud 내부 오디오 연결 시간이 초과되었습니다.")), 10000);
  });

  await connection.setRemoteDescription(message.offer);
  await connection.setLocalDescription(await connection.createAnswer());
  await waitForSoundCloudIceGathering(connection);
  sendSoundCloudBridgeStatus("SOUNDCLOUD_RTC_ANSWER", {
    connectionId: message.connectionId,
    answer: {
      type: connection.localDescription.type,
      sdp: connection.localDescription.sdp
    }
  });
  return streamPromise;
}

async function receiveSoundCloudDirectStream(message, timeoutMs = 5000) {
  let expired = false;
  let timer = null;
  const request = navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });
  request.then(stream => {
    if (expired) stream.getTracks().forEach(track => track.stop());
  }).catch(() => {});
  try {
    return await Promise.race([
      request,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("SoundCloud 직접 오디오 연결 시간이 초과되었습니다."));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trackFromSoundCloudExtension(event = {}) {
  return {
    urn: String(event.identity || event.permalinkUrl || soundCloudCurrentUrl || `soundcloud-tab:${soundCloudSourceTabId}`),
    title: String(event.title || "SoundCloud 트랙"),
    artist: String(event.artist || "SoundCloud"),
    permalinkUrl: String(event.permalinkUrl || soundCloudCurrentUrl || "https://soundcloud.com"),
    artworkUrl: String(event.artworkUrl || ""),
    durationMs: Math.max(0, Number(event.durationSeconds) || 0) * 1000
  };
}

function handleSoundCloudExtensionEvent(event = {}) {
  if (!soundCloudLifecycleController) return;
  soundCloudPositionSeconds = Math.max(0, Number(event.positionSeconds) || soundCloudPositionSeconds);
  soundCloudDurationSeconds = Math.max(0, Number(event.durationSeconds) || soundCloudDurationSeconds);
  if (event.type === "TRACK") {
    soundCloudTrack = trackFromSoundCloudExtension(event);
    soundCloudCurrentUrl = soundCloudTrack.permalinkUrl;
    soundCloudLifecycleController.loadTrack(soundCloudTrack);
  } else if (event.type === "PLAY") {
    soundCloudLifecycleController.play({ positionSeconds: soundCloudPositionSeconds });
    setAudioStatus("SoundCloud 탭 스트리밍 분석 중", "active");
  } else if (event.type === "PAUSE") {
    soundCloudLifecycleController.pause({ positionSeconds: soundCloudPositionSeconds });
    setAudioStatus("SoundCloud 탭 일시정지 · Flamingo 풀을 보존합니다.", "info");
  } else if (event.type === "FINISH") {
    soundCloudLifecycleController.finish({ positionSeconds: soundCloudPositionSeconds });
    setAudioStatus("SoundCloud 트랙 종료 · Flamingo 풀을 보존합니다.", "info");
  } else if (event.type === "RESTART") {
    soundCloudLifecycleController.restart();
    setAudioStatus("같은 SoundCloud 트랙을 처음부터 다시 재생합니다.", "active");
  } else if (event.type === "PROGRESS") {
    soundCloudLifecycleController.updatePosition(soundCloudPositionSeconds);
  }
  if (event.type !== "TRACK" && (event.title || event.artist || event.artworkUrl)) {
    soundCloudTrack = { ...(soundCloudTrack || {}), ...trackFromSoundCloudExtension(event) };
    soundCloudLifecycleController.updateTrackMetadata(soundCloudTrack);
  }
  updateSoundCloudDock();
}

async function attachSoundCloudExtensionStream(message) {
  const connectionId = String(message?.connectionId || "");
  const attachAttempt = ++soundCloudAttachAttempt;
  try {
    soundCloudAttachStage = "request_received";
    soundCloudAttachError = "";
    soundCloudAudioFlowReported = false;
    setAudioStatus("SoundCloud 탭 오디오를 연결하는 중…", "waiting");
    if (audioStarted) await releaseAudioResources();
    soundCloudAttachStage = "requesting_stream";
    captureStream = message.transport === "webrtc" && message.offer
      ? await receiveSoundCloudWebRtcStream(message)
      : await receiveSoundCloudDirectStream(message);
    if (attachAttempt !== soundCloudAttachAttempt) {
      captureStream.getTracks().forEach(track => track.stop());
      captureStream = null;
      return;
    }
    const [audioTrack] = captureStream.getAudioTracks();
    if (!audioTrack) throw new Error("SoundCloud 탭 오디오 스트림이 없습니다.");
    if (audioTrack.readyState !== "live") throw new Error(`SoundCloud 오디오 트랙 상태가 ${audioTrack.readyState}입니다.`);
    soundCloudAttachStage = "stream_acquired";
    audioTrack.addEventListener("ended", () => {
      if (!soundCloudReleasing) {
        sendSoundCloudBridgeStatus("SOUNDCLOUD_CONNECTION_CLOSED", {
          connectionId,
          reason: "media_stream_track_ended"
        });
        stopAudioCapture("SoundCloud 탭 연결이 종료되었습니다.");
      }
    }, { once: true });

    audioContext = audioContext && audioContext.state !== "closed" ? audioContext : createAudioContext();
    await resumeAudioContextWithoutBlocking(audioContext);
    soundCloudAttachStage = "configuring_audio_graph";
    await configureAudioGraph(audioContext.createMediaStreamSource(captureStream), {
      // Direct tab capture silences the source tab in Chrome. Route it back to
      // the listener here while feeding the exact same signal to the analyser.
      monitor: message.transport !== "webrtc",
      mode: "soundcloud"
    });
    soundCloudLifecycleController = new SoundCloudLifecycle.Controller({ onEvent: dispatchSoundCloudTransport });
    soundCloudExtensionAttached = true;
    soundCloudConnectionId = connectionId;
    soundCloudSourceTabId = message.sourceTabId;
    soundCloudCurrentUrl = String(message.sourceUrl || "");
    soundCloudTrack = { title: "SoundCloud 탭 연결됨", artist: "이벤트 기다리는 중", permalinkUrl: soundCloudCurrentUrl };
    soundCloudAttachStage = "attached";
    sendSoundCloudBridgeStatus("SOUNDCLOUD_ATTACH_RESULT", {
      connectionId,
      ok: true,
      audioContextState: audioContext.state,
      audioTrackState: audioTrack.readyState
    });
    setAudioStatus(
      audioContext.state === "running"
        ? "SoundCloud 탭 연결 완료 · 오디오 신호를 확인하는 중…"
        : "SoundCloud 탭 연결 완료 · 아래 ‘분석 시작’을 눌러 주세요.",
      "waiting"
    );
    setSoundCloudAnalysisButton(true, "SoundCloud 탭 직접 선택");
    updateSoundCloudDock();
    sendSoundCloudExtensionCommand("REQUEST_SNAPSHOT");
  } catch (error) {
    if (attachAttempt !== soundCloudAttachAttempt) return;
    console.error("SoundCloud extension stream attach failed:", error);
    soundCloudAttachStage = "error";
    soundCloudAttachError = readableSoundCloudAttachError(error);
    sendSoundCloudBridgeStatus("SOUNDCLOUD_ATTACH_RESULT", {
      connectionId,
      ok: false,
      error: soundCloudAttachError,
      audioContextState: audioContext?.state || "none",
      audioTrackState: captureStream?.getAudioTracks?.()[0]?.readyState || "none"
    });
    await releaseAudioResources();
    soundCloudAttachStage = "error";
    setAudioControlsRunning(false);
    setAudioStatus(`SoundCloud 연결 실패 · ${soundCloudAttachError}`, "error");
  }
}

window.addEventListener("pointerdown", async () => {
  if (!soundCloudExtensionAttached || audioContext?.state !== "suspended") return;
  await resumeAudioContextWithoutBlocking(audioContext, 3000);
  if (audioContext.state === "running") {
    setAudioStatus("SoundCloud 탭 스트리밍 분석 중", "active");
  }
}, true);

window.addEventListener("message", event => {
  const fromThisWindow = event.source === window && event.origin === location.origin;
  const fromEmbeddedParent = window.parent !== window && event.source === window.parent &&
    isAllowedEmbeddedParent(event.origin);
  if ((!fromThisWindow && !fromEmbeddedParent) || event.data?.source !== "music-shower-extension") return;
  const message = event.data;
  if (message.type === "EXTENSION_READY") {
    soundCloudExtensionAvailable = true;
    soundCloudExtensionVersion = String(message.version || soundCloudExtensionVersion || "");
    renderSoundCloudAvailability();
  } else if (message.type === "ATTACH_SOUNDCLOUD_TAB") {
    attachSoundCloudExtensionStream(message);
  } else if (message.type === "SOUNDCLOUD_EVENT") {
    handleSoundCloudExtensionEvent(message.event);
  } else if (message.type === "CAPTURE_ENDED" && !soundCloudReleasing &&
      (soundCloudExtensionAttached || audioInputMode === "soundcloud" || soundCloudAttachStage === "requesting_stream")) {
    soundCloudAttachAttempt += 1;
    if (soundCloudExtensionAttached || audioInputMode === "soundcloud") {
      stopAudioCapture("SoundCloud 탭 오디오 연결이 종료되었습니다.");
    }
  } else if (message.type === "CAPTURE_FAILED") {
    soundCloudAttachStage = "error";
    soundCloudAttachError = String(message.error || "탭 오디오 캡처 실패");
    setAudioControlsRunning(false);
    setAudioStatus(`SoundCloud 연결 실패 · ${soundCloudAttachError}`, "error");
  }
});

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
    pcmCaptureMetrics.stereo = packet.stereo || { available: false, reason: "mono_input", channels: 1 };
    RuntimePerformance?.recordAudioWorklet?.(pcmCaptureMetrics.processingMs);
    pcmCaptureMetrics.lastAt = performance.now();
    const hasAudibleSignal = pcmCaptureMetrics.rms > 0.0005 || pcmCaptureMetrics.peak > 0.002;
    if (mode === "soundcloud" && soundCloudExtensionAttached && hasAudibleSignal && !soundCloudAudioFlowReported) {
      soundCloudAudioFlowReported = true;
      soundCloudAttachStage = "audio_flowing";
      sendSoundCloudBridgeStatus("SOUNDCLOUD_AUDIO_FLOW", { connectionId: soundCloudConnectionId });
      setSoundCloudAnalysisButton(false);
      setAudioStatus("SoundCloud 오디오 감지됨 · 실시간 분석 중", "active");
    }
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
  if (mode === "soundcloud") {
    const stopButton = document.getElementById("stopButton");
    if (stopButton) stopButton.hidden = true;
  }
  setAudioStatus(
    mode === "file" ? "음원 파일 분석 중"
      : mode === "soundcloud" ? "SoundCloud 스트리밍 분석 중"
        : "탭/시스템 오디오 분석 중",
    "active"
  );
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

async function startSoundCloudTabShare() {
  let nextStream = null;
  try {
    setAudioStatus("Chrome 공유 창에서 재생 중인 SoundCloud 탭을 선택하고 ‘탭 오디오 공유’를 켜 주세요.", "waiting");
    nextStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      surfaceSwitching: "include"
    });

    nextStream.getVideoTracks().forEach(track => track.stop());
    const [audioTrack] = nextStream.getAudioTracks();
    if (!audioTrack) {
      nextStream.getTracks().forEach(track => track.stop());
      nextStream = null;
      throw new Error("선택한 탭에서 오디오가 공유되지 않았습니다. ‘탭 오디오 공유’를 켜고 다시 선택하세요.");
    }

    const extensionConnectionId = soundCloudConnectionId;
    soundCloudAttachAttempt += 1;
    if (extensionConnectionId) {
      sendSoundCloudBridgeStatus("SOUNDCLOUD_CONNECTION_CLOSED", {
        connectionId: extensionConnectionId,
        reason: "native_tab_share_selected"
      });
    }
    if (audioStarted || captureStream) await releaseAudioResources();
    captureStream = nextStream;
    nextStream = null;
    audioTrack.addEventListener("ended", () => stopAudioCapture("SoundCloud 탭 공유가 종료되었습니다."), {
      once: true
    });

    audioContext = createAudioContext();
    await audioContext.resume();
    await configureAudioGraph(audioContext.createMediaStreamSource(captureStream), {
      monitor: false,
      mode: "display"
    });
    setSoundCloudAnalysisButton(false);
    setAudioStatus("SoundCloud 탭 오디오 감지 중 · 음악이 들리면 단어가 곧 생성됩니다.", "active");
    return true;
  } catch (error) {
    nextStream?.getTracks?.().forEach(track => track.stop());
    console.error("SoundCloud tab sharing failed:", error);
    setAudioStatus(
      error?.name === "NotAllowedError"
        ? "탭 공유가 취소되었습니다. 다시 누르고 SoundCloud 탭과 ‘탭 오디오 공유’를 선택하세요."
        : error.message || "SoundCloud 탭 오디오를 공유하지 못했습니다.",
      "error"
    );
    setSoundCloudAnalysisButton(true, "SoundCloud 탭 직접 선택");
    return false;
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

function normalizeSoundCloudWidgetUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    const allowed = host === "soundcloud.com" || host === "www.soundcloud.com" ||
      host === "m.soundcloud.com" || host === "on.soundcloud.com";
    if (url.protocol !== "https:" || !allowed) return "";
    url.hash = "";
    // Share links often append tracking-only query strings. They must not make the same track look
    // like a new identity and clear its Flamingo pool on replay.
    url.search = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

async function startSoundCloudStream(trackUrl) {
  const url = normalizeSoundCloudWidgetUrl(trackUrl);
  if (!url) {
    setAudioStatus("공개 SoundCloud 트랙의 https URL을 입력해 주세요.", "error");
    return false;
  }
  if (!isCurrentSoundCloudExtension()) {
    setAudioStatus("chrome://extensions에서 Music Shower 확장 프로그램을 새로고침한 뒤 이 페이지도 새로고침하세요.", "error");
    return false;
  }

  try {
    if (soundCloudExtensionAttached) {
      sendSoundCloudExtensionCommand("LOAD_URL", url);
      setAudioStatus("연결된 SoundCloud 탭에서 새 트랙을 여는 중…", "waiting");
      return true;
    }
    if (!audioContext || audioContext.state === "closed") audioContext = createAudioContext();
    await audioContext.resume();
    soundCloudCurrentUrl = url;
    window.open(url, "music-shower-soundcloud");
    setAudioStatus("열린 SoundCloud 탭에서 Music Shower 확장 아이콘을 눌러 연결하세요.", "waiting");
    return true;
  } catch (error) {
    console.error("SoundCloud tab preparation failed:", error);
    setAudioStatus(error.message || "SoundCloud 탭을 열지 못했습니다.", "error");
    return false;
  }
}

async function toggleSoundCloudPlayback() {
  if (!soundCloudExtensionAttached) return;
  await audioContext?.resume?.();
  const transport = soundCloudLifecycleController?.snapshot()?.transport;
  sendSoundCloudExtensionCommand(transport === "playing" ? "PAUSE" : "PLAY");
}

async function restartSoundCloudTrack() {
  if (!soundCloudExtensionAttached) return;
  await audioContext?.resume?.();
  sendSoundCloudExtensionCommand("RESTART");
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
    lastAt: pcmCaptureMetrics.lastAt,
    ageMs: pcmCaptureMetrics.lastAt ? Math.max(0, performance.now() - pcmCaptureMetrics.lastAt) : Infinity,
    bands: pcmCaptureMetrics.bands,
    processingMs: pcmCaptureMetrics.processingMs,
    transport: pcmCaptureMetrics.transport,
    stereo: pcmCaptureMetrics.stereo || { available: false, reason: "mono_input", channels: 1 }
  };
}

// SoundCloud tab capture can deliver PCM before the 500ms expression scheduler has projected
// it into semanticState.expressionFeatures. Keep this low-level signal independent: otherwise
// the background and classifier continue moving while the word spawner and Deep Listen both see
// `audible === false` and silently stop.
function hasCurrentAudioSignal(maxAgeMs = 1200) {
  const age = pcmCaptureMetrics.lastAt ? performance.now() - pcmCaptureMetrics.lastAt : Infinity;
  if (age > maxAgeMs) return false;
  return Number(pcmCaptureMetrics.rms) > 0.0005 || Number(pcmCaptureMetrics.peak) > 0.002;
}

async function releaseAudioResources() {
  soundCloudReleasing = true;
  stopAIAnalysisLoop();
  endSemanticSession();
  if (typeof releaseDeepListenResources === "function") releaseDeepListenResources();

  meydaFeatureWorker?.terminate();
  meydaFeatureWorker = null;
  meydaWorkerBusy = false;

  captureStream?.getTracks().forEach(track => track.stop());
  captureStream = null;
  soundCloudPeerConnection?.close();
  soundCloudPeerConnection = null;

  if (fileAudioElement) {
    fileAudioElement.pause();
    fileAudioElement.removeAttribute("src");
    fileAudioElement.load();
  }
  fileAudioElement = null;

  if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl);
  fileObjectUrl = null;

  soundCloudLifecycleController?.disconnect();
  soundCloudExtensionAttached = false;
  soundCloudConnectionId = "";
  soundCloudAudioFlowReported = false;
  soundCloudSourceTabId = null;
  soundCloudLifecycleController = null;
  soundCloudTrack = null;
  soundCloudCurrentUrl = "";
  soundCloudPositionSeconds = 0;
  soundCloudDurationSeconds = 0;
  soundCloudReleasing = false;
  const soundCloudDock = document.getElementById("soundCloudDock");
  if (soundCloudDock) soundCloudDock.hidden = true;
  setSoundCloudAnalysisButton(false);

  try {
    sourceNode?.disconnect();
  } catch (error) {
    console.warn("Audio source disconnect failed:", error);
  }

  try {
    if (pcmCaptureNode?.port) {
      pcmCaptureNode.port.onmessage = null;
      pcmCaptureNode.port.close();
    }
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
