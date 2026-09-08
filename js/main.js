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
  for (const formId of ["soundCloudConnectForm", "soundCloudChangeForm"]) {
    document.getElementById(formId)?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const input = form.querySelector("input[type='url']");
      const button = form.querySelector("button[type='submit']");
      if (button) button.disabled = true;
      try {
        const connected = await startSoundCloudStream(input?.value);
        if (connected && formId === "soundCloudChangeForm" && input) input.value = "";
      } finally {
        if (button) button.disabled = false;
      }
    });
  }
  document.getElementById("soundCloudToggleButton")?.addEventListener("click", toggleSoundCloudPlayback);
  document.getElementById("soundCloudRestartButton")?.addEventListener("click", restartSoundCloudTrack);
  document.getElementById("soundCloudAnalysisButton")?.addEventListener("click", resumeSoundCloudAnalysis);
  document.getElementById("soundCloudDisconnectButton")?.addEventListener("click", () => {
    stopAudioCapture("SoundCloud 연결을 종료했습니다.");
  });
  window.addEventListener("music-shower:soundcloud-transport", handleSoundCloudTransport);
  refreshSoundCloudAvailability();
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

function handleSoundCloudTransport(event) {
  const detail = event?.detail || {};
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  if (!lifecycle) return;
  lastLifecycleBoundary = {
    type: detail.type || "SOUNDCLOUD_EVENT",
    reason: "soundcloud_tab_extension",
    authoritative: true,
    identity: detail.identity || null
  };

  if (detail.type === "TRACK_CHANGED") {
    lifecycle.resetForNewTrack("soundcloud_track_changed");
    resetDeepListenTrackRuntime();
  } else if (detail.type === "PAUSED" || detail.type === "FINISHED") {
    lifecycle.freezeForPause();
  } else if (detail.type === "RESUMED" || detail.type === "RESTARTED") {
    lifecycle.resumeSameTrack();
  } else if (detail.type === "STARTED") {
    lifecycle.tickAuthoritative({ isPlaying: true, now: Date.now() });
  }
}

// Periodic direct-audio (Music Flamingo) capture. Unlike the first version of this feature, a
// caption never goes straight to the screen: it becomes candidate observations
// (lib/directAudioReview.js's toObservations(), server-side) fed into the SAME evidence-fusion /
// temporal-stability pipeline every other source uses (js/semantic/semanticEngine.js's
// applyDirectAudioObservations() -> updateTemporalEvidence()) -- it earns its confidence there,
// same as a classifier or DSP read, rather than being handed a shortcut.
//
// A ROLLING 30s window, never a growing one: Music Flamingo's audio encoder is a Whisper-derived
// feature extractor with a hard chunk_length of 30s (models/research/music-flamingo/
// processor_config.json). Verified directly against the real processor -- feeding it 30s, 60s and
// 90s of audio all produced the IDENTICAL input_features/attention_mask shape ([1,128,3000] /
// [1,480000] = exactly 30s at 16kHz). It silently truncates anything past the first 30 seconds, so
// sending a longer "accumulated" clip does not add context -- it makes every capture re-analyze the
// SAME stale opening 30 seconds instead of the current one, which is strictly worse. Every capture
// is interpreted independently; track continuity is assembled by the browser evidence registry so
// one model answer can never anchor the next listen.
//
// Cadence is 45 audible seconds rather than 30. Measured inference on this machine runs 20-60s
// for a full 512-token packet, so a 30s cadence was nominal only: the `active` guard already made
// the real period max(30s, inference). A single bounded pending window now preserves the next
// scheduled section while inference is busy, without creating an unbounded GPU backlog.
// Below this the newest audio frames carry no music. Deliberately above musicExpressionEngine's
// 0.001 expression threshold: a track gap is digital silence or near it, and a threshold that low
// counts dither and encoder noise as "still playing".
const GAP_SILENCE_RMS = 0.004;
// The audio encoder treats 30s as a CEILING, not a requirement -- a shorter clip is padded, and
// the capture path already accepts anything over 5s. Waiting a full 30 audible seconds before the
// first capture was therefore a free 30s of silence from the deep listener, on top of the ~50s
// the inference itself takes: nothing Flamingo-derived could reach the screen for ~90s.
// The first capture is a FIRST IMPRESSION instead -- sooner, shallower, and explicitly uncertain.
// It enters the registry as `emerging` belief, which later full captures strengthen or weaken,
// which is exactly what the reversible belief states are for.
const DEEP_LISTEN_FIRST_CAPTURE_SECONDS = 12;
const DEEP_LISTEN_CHUNK_SECONDS = 30;
const DEEP_LISTEN_MAX_CAPTURE_SECONDS = 30;
const DEEP_LISTEN_RECAPTURE_INTERVAL_SECONDS = 45;
const DEEP_LISTEN_BUFFER_FLUSH_MS = 250;
const MAX_REALIZATION_REQUESTS = 2;
const DeepListenSchedulerType = typeof DeepListenWindowScheduler !== "undefined" ? DeepListenWindowScheduler : null;
const deepListenScheduler = DeepListenSchedulerType
  ? new DeepListenSchedulerType.Scheduler({
    firstCaptureSeconds: DEEP_LISTEN_FIRST_CAPTURE_SECONDS,
    recaptureIntervalSeconds: DEEP_LISTEN_RECAPTURE_INTERVAL_SECONDS,
    maxPending: 1
  }) : null;
const deepListenState = {
  active: false,
  lastTriggeredAt: 0,
  activeListeningMs: 0,
  lastTickAt: 0,
  audible: null,
  sessionKey: null,
  requestSequence: 0,
  // Track invalidation and per-track segment numbering are deliberately separate. Reusing the
  // segment counter as an invalidation token made every track's first real upload segment 2,
  // accidentally enabling classifier assistance on what was supposed to be a blind listen.
  requestGeneration: 0,
  controller: null,
  pendingCapture: null,
  bufferedCaptureMs: 0,
  realizationGeneration: 0,
  realizationControllers: new Set()
};
// Accumulates only audibly-active PCM (js/audio/audibleAudioBuffer.js) so a Deep Listen capture
// reflects actual music, never a pause's silence. Reset only on a genuine track change -- a
// pause must keep it, since the old and new song must never mix but a resume is still one song.
let deepListenAudibleBuffer = null;
// The most recent tick's raw boundary result (js/semantic/trackLifecycleEngine.js), including
// types that never change `state` (e.g. CONTINUOUS, PAUSE_SUSPECTED) -- kept for the T-panel so
// "is anything even being evaluated right now" is visible independent of state transitions.
let lastLifecycleBoundary = null;

function createDeepListenSessionKey() {
  const uniqueSession = globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${uniqueSession}:${getSemanticState()?.sessionId || 0}`.slice(0, 40);
}

function resetDeepListenTrackRuntime() {
  deepListenState.controller?.abort();
  for (const controller of deepListenState.realizationControllers) controller.abort();
  deepListenState.realizationControllers.clear();
  deepListenState.active = false;
  deepListenState.lastTriggeredAt = 0;
  deepListenState.activeListeningMs = 0;
  deepListenState.lastTickAt = performance.now();
  deepListenState.audible = null;
  deepListenState.bufferedCaptureMs = 0;
  deepListenAudibleBuffer?.reset();
  lastWordSpawnTime = 0;
  // The key scopes cancellation and response validation. Flamingo generation itself is memory-free.
  deepListenState.sessionKey = createDeepListenSessionKey();
  deepListenState.requestSequence = 0;
  deepListenState.requestGeneration += 1;
  deepListenState.realizationGeneration += 1;
  deepListenState.controller = null;
  deepListenState.pendingCapture = null;
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  deepListenScheduler?.reset(lifecycle ? lifecycle.getTrackEpoch() : 1);
}

function resetDeepListenRuntime() {
  resetDeepListenTrackRuntime();
}

function releaseDeepListenResources() {
  resetDeepListenTrackRuntime();
  // reset() preserves the allocation for a same-page track change; a real stop/page teardown
  // should return the 30-second Float32 backing store to the browser.
  deepListenAudibleBuffer = null;
}

function isDeepListenGpuBusy() {
  return deepListenState.active;
}

// Exposes the Deep Listen capture pipeline's live state for the T-panel (js/semantic/
// trackStatusInspector.js): how much of the rolling 30s window has filled, whether that's because
// audio is actively accumulating or frozen mid-pause, and when the next capture is due.
function getDeepListenStatus() {
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  const cadenceDueAtMs = deepListenState.lastTriggeredAt
    ? deepListenState.lastTriggeredAt + DEEP_LISTEN_RECAPTURE_INTERVAL_SECONDS * 1000
    : DEEP_LISTEN_FIRST_CAPTURE_SECONDS * 1000;
  return {
    uploadInFlight: deepListenState.active,
    pendingWindow: Boolean(deepListenState.pendingCapture) || Boolean(deepListenScheduler?.inspect()?.pendingWindow),
    pendingCount: deepListenScheduler?.inspect()?.pendingCount || (deepListenState.pendingCapture ? 1 : 0),
    currentlyAudible: deepListenState.audible,
    activeListeningMs: deepListenState.activeListeningMs,
    cadenceDueAtMs,
    msUntilNextCapture: Math.max(0, cadenceDueAtMs - deepListenState.activeListeningMs),
    audibleBufferSeconds: deepListenAudibleBuffer ? deepListenAudibleBuffer.seconds() : 0,
    audibleBufferCapSeconds: DEEP_LISTEN_MAX_CAPTURE_SECONDS,
    chunkSeconds: DEEP_LISTEN_CHUNK_SECONDS,
    requestSequence: deepListenState.requestSequence,
    lastTriggeredAtMs: deepListenState.lastTriggeredAt,
    lastBoundary: lastLifecycleBoundary,
    lifecycle: lifecycle ? lifecycle.inspect() : null
  };
}

function updateWordSpawner() {
  if (!audioStarted) return;
  const now = millis();
  const state = getSemanticState();
  const tickAt = performance.now();
  const tickDelta = deepListenState.lastTickAt ? Math.min(250, Math.max(0, tickAt - deepListenState.lastTickAt)) : 0;
  deepListenState.lastTickAt = tickAt;
  const expressionAudible = state.expressionFeatures?.audible !== false ||
    (typeof hasCurrentAudioSignal === "function" && hasCurrentAudioSignal());
  const soundCloudState = typeof getSoundCloudPlaybackState === "function"
    ? getSoundCloudPlaybackState()
    : null;
  const soundCloudAuthoritative = audioInputMode === "soundcloud" && soundCloudState?.connected;
  // Metadata events can arrive a little after the media stream starts. If the capture itself is
  // audibly producing PCM while transport is still disconnected/ready, treat that as playing
  // for the downstream word/deep-listen path. Explicit PAUSED/ENDED remain authoritative and
  // still preserve the Flamingo pool indefinitely.
  const soundCloudSignal = typeof hasCurrentAudioSignal === "function" && hasCurrentAudioSignal();
  const soundCloudPlaying = soundCloudState?.transport === "playing" ||
    (["disconnected", "ready"].includes(soundCloudState?.transport) && soundCloudSignal);
  // The DSP audibility estimate is deliberately smoothed, so it can remain true briefly after
  // pause. For the owned SoundCloud player, transport is authoritative and must stop capture and
  // listening-time accumulation immediately while leaving the existing word pool untouched.
  const audible = soundCloudAuthoritative
    // An explicit SoundCloud PLAY event is authoritative even while the expression scheduler is
    // catching up. If the event bridge is still at READY/DISCONNECTED, require the low-level PCM
    // signal so a dead capture cannot manufacture Deep Listen time.
    ? soundCloudState.transport === "playing" || (soundCloudPlaying && expressionAudible)
    : expressionAudible;

  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  if (lifecycle) {
    if (soundCloudAuthoritative) {
      lifecycle.tickAuthoritative({
        isPlaying: soundCloudPlaying,
        now: Date.now()
      });
      if (soundCloudState.lastEvent) {
        lastLifecycleBoundary = {
          type: soundCloudState.lastEvent.type,
          reason: "soundcloud_tab_extension",
          authoritative: true,
          identity: soundCloudState.identity || null
        };
      }
    } else {
    const previousLifecycleState = lifecycle.getState();
    const previousTrackEpoch = lifecycle.getTrackEpoch();
    const boundaryAudio = typeof getTrackBoundaryAudioFeatures === "function"
      ? getTrackBoundaryAudioFeatures()
      : {};
    const features = {
      bpm: typeof bpm !== "undefined" ? bpm : 0,
      bpmConfidence: typeof bpmConfidence !== "undefined" ? bpmConfidence : 0,
      spectralNovelty: state.novelty?.score || 0,
      embeddingNovelty: state.novelty?.embeddingDistance || 0,
      centroid: boundaryAudio.centroid || state.audio?.centroid || 0,
      flatness: boundaryAudio.flatness ?? state.audio?.flatness,
      rms: boundaryAudio.rms || state.audio?.rms || 0,
      // The semantic state's chroma/MFCC describe a long observation window. Boundary detection
      // gets a separate ~2.4s identity profile so a crossfade cannot slowly walk a 30s average from
      // Song A into Song B without ever looking discontinuous.
      chroma: boundaryAudio.chroma?.length ? boundaryAudio.chroma : state.audio?.chroma,
      mfcc: boundaryAudio.mfcc?.length ? boundaryAudio.mfcc : state.audio?.mfcc,
      bands: boundaryAudio.bands
    };
    // Audibility for BOUNDARY purposes is a different question from audibility for expression.
    // musicExpressionEngine's `audible` rides a long smoothed RMS, which is right for "is there
    // music to describe" and useless for "did the stream just go quiet between two songs" -- a
    // 1-second inter-track gap never moves that average below its threshold. Use the newest
    // frames, and only fall back to the smoothed answer when they are unavailable.
    const instantRms = Number.isFinite(boundaryAudio.instantPeakRms)
      ? boundaryAudio.instantPeakRms
      : (Number.isFinite(boundaryAudio.instantRms) ? boundaryAudio.instantRms : null);
    const audibleForBoundary = instantRms === null ? audible : instantRms > GAP_SILENCE_RMS;
    const tickResult = lifecycle.tick({ isAudible: audibleForBoundary, now: Date.now(), features });
    lastLifecycleBoundary = tickResult.boundary || null;
    const trackChanged = tickResult.trackEpoch !== previousTrackEpoch;
    const audioWasRemoved = tickResult.boundary?.type === "AUDIO_REMOVED" &&
      previousLifecycleState !== "AUDIO_REMOVED" && previousLifecycleState !== "NO_AUDIO";
    if (trackChanged || audioWasRemoved) {
      // A genuinely new track (or audio that is confirmed gone, not just paused) must never let
      // the old song's tail sit in the Deep Listen capture buffer -- unlike a mere pause, which
      // deliberately keeps the buffer so the same song can top it back up to 30s on resume.
      // This also resets the per-track listening clock. Without it Song B could immediately meet
      // Song A's 30s/45s cadence and upload a short, mixed fragment as if it were mature evidence.
      resetDeepListenTrackRuntime();
    }
    }
  }

  // Only audibly-active PCM chunks enter the Deep Listen capture cache -- a pause's silence is
  // skipped rather than occupying capture duration, so buffered seconds means seconds of actual
  // music (js/audio/audibleAudioBuffer.js), not wall clock. The cache keeps growing (up to
  // DEEP_LISTEN_MAX_CAPTURE_SECONDS) across the whole song rather than being trimmed back to 30s
  // after each capture -- a capture reads whatever has accumulated, it never consumes/resets it.
  if (audible && tickDelta > 0 && typeof mlAudioWindow !== "undefined" && mlAudioWindow && audioContext) {
    if (!deepListenAudibleBuffer && typeof AudibleAudioBuffer !== "undefined") {
      deepListenAudibleBuffer = new AudibleAudioBuffer.AudibleAudioBuffer(audioContext.sampleRate, DEEP_LISTEN_MAX_CAPTURE_SECONDS);
    }
    // Batch ring reads instead of allocating a new Float32Array on every animation frame.
    // At 60 FPS this cuts capture-side allocations and writes by roughly 15x without dropping
    // audible time from the 30-second window.
    deepListenState.bufferedCaptureMs += tickDelta;
    if (deepListenState.bufferedCaptureMs >= DEEP_LISTEN_BUFFER_FLUSH_MS) {
      const captureMs = deepListenState.bufferedCaptureMs;
      deepListenState.bufferedCaptureMs = 0;
      deepListenAudibleBuffer?.push(mlAudioWindow.latestNative(captureMs / 1000));
    }
  } else if (!audible) {
    // Never carry a partial timing bucket across a pause: reading it after resume could pull
    // wall-clock silence into the audible-only buffer. At most 249ms of music is discarded.
    deepListenState.bufferedCaptureMs = 0;
  }

  if (audible) deepListenState.activeListeningMs += tickDelta;
  deepListenState.audible = audible;

  if (audible && typeof mlAudioWindow !== "undefined" && mlAudioWindow) {
    const sessionMs = deepListenState.activeListeningMs;
    const cadenceDueAt = deepListenState.lastTriggeredAt
      ? deepListenState.lastTriggeredAt + DEEP_LISTEN_RECAPTURE_INTERVAL_SECONDS * 1000
      : DEEP_LISTEN_FIRST_CAPTURE_SECONDS * 1000;
    if (sessionMs > cadenceDueAt) {
      const firstImpression = !deepListenState.lastTriggeredAt;
      if (!deepListenState.active) {
        const capture = captureDeepListenWindow(firstImpression);
        if (capture) {
          deepListenState.lastTriggeredAt = sessionMs;
          deepListenScheduler?.markTriggered(sessionMs);
          triggerDeepAnalysisUpload({ capture });
        }
      } else if (!deepListenState.pendingCapture) {
        // Keep one scheduled audio window while the GPU is busy. One slot preserves the next
        // unheard section without building an ever-growing inference backlog.
        const capture = captureDeepListenWindow(false);
        if (capture) {
          deepListenScheduler?.enqueuePending(capture);
          deepListenState.pendingCapture = capture;
          deepListenState.lastTriggeredAt = sessionMs;
          deepListenScheduler?.markTriggered(sessionMs);
        }
      }
    }
  }

  // Silence and pauses are listening gaps, not low-energy musical statements. Existing words
  // finish naturally, but new words and Deep Listen captures wait for sound to resume.
  if (!audible) return;

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

function captureDeepListenWindow(firstImpression = false) {
  if (!mlAudioWindow || !audioContext) return null;
  const semanticSnapshot = getSemanticState();
  const sessionId = semanticSnapshot.sessionId;
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  const trackEpoch = lifecycle ? lifecycle.getTrackEpoch() : 1;
  // Prefer the audible-only buffer (silence from pauses never occupies capture duration); fall
  // back to the raw wall-clock window only if it hasn't accumulated anything yet.
  let pcm = deepListenAudibleBuffer && deepListenAudibleBuffer.seconds() >= 5
    ? deepListenAudibleBuffer.snapshot()
    : mlAudioWindow.latestNative(30);
  if (!pcm || pcm.length < audioContext.sampleRate * 5) return null;
  return {
    pcm,
    firstImpression,
    sessionId,
    sessionKey: deepListenState.sessionKey || String(sessionId),
    trackEpoch,
    activeAudioMs: deepListenState.activeListeningMs,
    requestGeneration: deepListenState.requestGeneration
  };
}

function triggerDeepAnalysisUpload({ firstImpression = false, capture = null } = {}) {
  capture = capture || captureDeepListenWindow(firstImpression);
  if (!capture || deepListenState.active || capture.requestGeneration !== deepListenState.requestGeneration) return;
  let { pcm } = capture;
  firstImpression = Boolean(capture.firstImpression);
  const { sessionId, sessionKey, trackEpoch, activeAudioMs } = capture;
  // Response validation and the follow-up genre/realization requests all run asynchronously in
  // this function's promise chain. The capture helper's local `lifecycle` binding is not visible
  // here; keeping the authoritative engine in this closure prevents a successful server response
  // from dying with `ReferenceError: lifecycle is not defined` before reservoir ingestion.
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  // Count only uploads that can actually start. A timer tick before five audible seconds must not
  // consume sequence 1 and mislabel the first real Flamingo hearing as a later full capture.
  const requestSequence = ++deepListenState.requestSequence;
  const requestGeneration = capture.requestGeneration;
  const requestId = `flam-req-${trackEpoch}-${requestSequence}-${Date.now()}`;
  deepListenState.active = true;
  const controller = new AbortController();
  deepListenState.controller = controller;
  const clipSeconds = (pcm.length / audioContext.sampleRate).toFixed(1);
  let buffer = pcmToWav(pcm, audioContext.sampleRate);
  // WAV conversion has its own compact Int16 copy. Drop the larger Float32 snapshot before the
  // request spends tens of seconds waiting for Flamingo generation.
  pcm = null;
  console.log(`[Deep Listen] capturing ${clipSeconds}s audio (trackEpoch=${trackEpoch}) and uploading to /api/deep-analysis...`);
  const deepAnalysisHeaders = {
    "Content-Type": "audio/wav",
    "X-Music-Shower-Session": sessionKey,
    "X-Music-Shower-Segment": String(requestSequence),
    "X-Music-Shower-Track-Epoch": String(trackEpoch),
    "X-Music-Shower-Request-Id": requestId,
    "X-Music-Shower-Active-Ms": String(Math.round(activeAudioMs))
  };
  if (firstImpression) deepAnalysisHeaders["X-Music-Shower-Listen-Depth"] = "first-impression";
  fetch("/api/deep-analysis", { method: "POST", headers: deepAnalysisHeaders,
    body: buffer, signal: controller.signal })
    .then(res => {
      if (!res.ok) throw new Error(`Deep Listen HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (!audioStarted || getSemanticState().sessionId !== sessionId ||
          deepListenState.requestGeneration !== requestGeneration ||
          deepListenState.requestSequence !== requestSequence) return;
      if (lifecycle && !lifecycle.validateResponse(data.trackEpoch)) {
        console.warn(`[Deep Listen] Stale response dropped: packet trackEpoch ${data.trackEpoch} !== current trackEpoch ${lifecycle.getTrackEpoch()}`);
        return;
      }
      if (data.error) { console.error("[Deep Listen] server reported an error:", data.error); return; }
      console.log("[Deep Listen] caption:", data.caption);
      console.log(`[Deep Listen] ${data.observations?.length || 0} observation(s) ->`, data.observations);
      if (Array.isArray(data.observations)) {
        const applied = applyDirectAudioObservations(data.observations, {
          observationId: data.observationId,
          structuredPacket: data.structuredPacket,
          sessionId,
          trackEpoch: data.trackEpoch,
          requestId: data.requestId,
          audioSegmentId: data.segmentId || null,
          continuity: data.continuity || null
        });
        const ingestion = getSemanticState()?.flamingoIngestion;
        console.log(`[Deep Listen] reservoir ${applied && ingestion?.accepted ? "accepted" : "not accepted"}:`, ingestion || {});
      }

      // CONTEXT stage three: reconcile the classifier's reading with Flamingo's. Fire-and-forget
      // and strictly additive -- the classifier's own genre remains what CONTEXT uses until this
      // returns, so a slow or failed reconciliation costs nothing but the extra reading.
      const heardGenres = (data.structuredPacket?.genreHypotheses || [])
        .map(item => ({ label: typeof item === "string" ? item : item?.label,
          confidence: typeof item === "object" ? item?.confidence : undefined }))
        .filter(item => item.label);
      if (heardGenres.length && typeof GenreAdvisory !== "undefined") {
        const classifierReading = GenreAdvisory.build(getSemanticState());
        const composeController = new AbortController();
        deepListenState.controller?.signal?.addEventListener?.("abort",
          () => composeController.abort(), { once: true });
        const history = typeof getGenreEvidenceHistory === "function" ? getGenreEvidenceHistory()?.snapshot?.() : null;
        fetch("/api/compose-genre", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            classifier: classifierReading,
            deepListen: heardGenres,
            uncertainties: data.structuredPacket?.uncertainties || [],
            localGenreHistory: history?.localGenreHistory || [],
            blindFlamingoGenreHistory: history?.blindFlamingoGenreHistory || [],
            audibleObservations: data.structuredPacket?.audibleObservations || [],
            signatureRelations: data.structuredPacket?.signatureRelations || [],
            flamingoIndependent: data.continuity?.independent !== false &&
              data.continuity?.listeningMode !== "assisted",
            classifierIndependent: true,
            listeningMode: data.continuity?.listeningMode === "assisted" ? "assisted" : "blind"
          }),
          signal: composeController.signal
        })
          .then(res => (res.ok ? res.json() : null))
          .then(result => {
            if (!result?.composite?.length) return;
            if (lifecycle && !lifecycle.validateResponse(data.trackEpoch)) return;
            if (typeof applyComposedGenre !== "function") return;
            const accepted = applyComposedGenre(result.composite, {
              trackEpoch: data.trackEpoch,
              observationId: `${data.observationId || data.requestId}-composed`,
              audioSegmentId: data.segmentId || null,
              uncertainties: result.uncertainties
            });
            if (accepted) {
              console.log("[Genre] composed reading:", result.composite
                .map(item => `${item.label} (${item.relation}, ${item.confidence})`).join(" · "));
            }
          })
          .catch(error => {
            if (error?.name !== "AbortError") console.warn("[Genre] composition unavailable:", error.message);
          });
      }

      // Asynchronous background Korean realization expansion (bypasses regular language pool cooldown)
      if (data.structuredPacket) {
        const toExpand = [];
        const categories = ["audibleObservations", "signatureRelations", "contextHypotheses", "aestheticConcepts", "impressions"];
        for (const catKey of categories) {
          for (const raw of (data.structuredPacket[catKey] || [])) {
            const text = typeof raw === "string" ? raw : raw?.text;
            if (text && !/[가-힣]/.test(text)) {
              const category = typeof FlamingoWordReservoir !== "undefined" && FlamingoWordReservoir.facetForPacketItem
                ? FlamingoWordReservoir.facetForPacketItem(catKey, raw, text)
                : catKey === "aestheticConcepts" ? "association"
                : catKey === "impressions" ? "mood"
                  : catKey === "contextHypotheses" ? (["scene", "era", "culture", "lineage"].includes(raw?.category) ? raw.category : null)
                    : (raw?.category || null);
              if (!category) continue;
              const layer = ["audibleObservations", "signatureRelations"].includes(catKey) ? "FACT"
                : catKey === "contextHypotheses" ? "CONTEXT"
                  : catKey === "aestheticConcepts" ? "AESTHETIC" : "IMPRESSION";
              toExpand.push({ text, category, layer });
            }
          }
        }
        if (toExpand.length > 0) {
          const realizationGeneration = deepListenState.realizationGeneration;
          const realizationController = new AbortController();
          while (deepListenState.realizationControllers.size >= MAX_REALIZATION_REQUESTS) {
            const oldest = deepListenState.realizationControllers.values().next().value;
            oldest?.abort();
            deepListenState.realizationControllers.delete(oldest);
          }
          deepListenState.realizationControllers.add(realizationController);
          fetch("/api/realize-direct-audio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ concepts: toExpand, sessionId, trackEpoch }),
            signal: realizationController.signal
          })
            .then(res => {
              if (!res.ok) throw new Error(`Korean realization HTTP ${res.status}`);
              return res.json();
            })
            .then(resData => {
              if (realizationGeneration !== deepListenState.realizationGeneration ||
                  !audioStarted || getSemanticState().sessionId !== sessionId ||
                  (lifecycle && lifecycle.getTrackEpoch() !== Number(resData.trackEpoch))) return;
              const reservoir = typeof getFlamingoWordReservoir === "function" ? getFlamingoWordReservoir() : null;
              const realizer = typeof DirectAudioRealizer !== "undefined" ? DirectAudioRealizer : null;
              const realizedItems = Array.isArray(resData.realizationItems)
                ? resData.realizationItems
                : Object.entries(resData.realizations || {}).map(([text, family]) => ({ text, family }));
              let appliedCount = 0;
              for (const item of realizedItems) {
                const conceptText = item.text;
                const family = item.family;
                // REPLACE, never merge: the synchronous fallback (plain English, or a dictionary
                // guess) must not keep surfacing in rotation once genuine LLM Korean phrasing has
                // arrived for the same concept (js/semantic/flamingoWordReservoir.js).
                if (reservoir?.applyRealization(conceptText, family, item.category || null)) {
                  realizer?.registerFamily(conceptText, family);
                  appliedCount += 1;
                }
              }
              if (appliedCount > 0) {
                const currentState = getSemanticState();
                currentState.flamingoReservoirCandidates = reservoir.getCandidates();
                if (typeof refreshSemanticWords === "function") refreshSemanticWords(false);
              }
              if (Array.isArray(resData.failures) && resData.failures.length) {
                console.warn("[Deep Listen] some Korean realization batches failed:", resData.failures);
              }
            })
            .catch(error => {
              if (error.name !== "AbortError") console.warn("[Deep Listen] Korean realization failed:", error.message || error);
            })
            .finally(() => deepListenState.realizationControllers.delete(realizationController));
        }
      }
    })
    .catch(error => {
      if (error.name !== "AbortError") console.error("[Deep Listen] request failed (is flamingo_server.py running on :5005?):", error);
    })
    .finally(() => {
      buffer = null;
      if (deepListenState.requestGeneration === requestGeneration &&
          deepListenState.requestSequence === requestSequence) {
        deepListenState.active = false;
        deepListenState.controller = null;
        const pending = deepListenScheduler?.takePending() || deepListenState.pendingCapture;
        deepListenState.pendingCapture = deepListenScheduler?.pending?.[0] || null;
        if (pending) queueMicrotask(() => triggerDeepAnalysisUpload({ capture: pending }));
      }
    });
}

function publishAudioFeaturesToParent() {
  if (window.parent === window) return;
  const now = performance.now();
  if (now - (publishAudioFeaturesToParent._at || 0) < 33) return;
  publishAudioFeaturesToParent._at = now;
  let parentOrigin = "";
  try { parentOrigin = new URL(document.referrer).origin; } catch { return; }
  if (typeof isAllowedEmbeddedParent !== "function" || !isAllowedEmbeddedParent(parentOrigin)) return;

  const bands = typeof realtimeAudioFeatures === "object" ? realtimeAudioFeatures.bands || {} : {};
  const capture = typeof getAudioCaptureDebugState === "function" ? getAudioCaptureDebugState() : {};
  const rms = Math.max(0, Math.min(1, Number(latestMeasuredFeatures?.rms ?? capture.rms) * 3.2 || 0));
  const kickPulse = typeof beatFlash === "number" ? beatFlash : 0;
  const onsets = typeof onsetEvents !== "undefined" && onsetEvents.values ? onsetEvents.values() : [];
  const recent = onsets[onsets.length - 1];
  const recentAge = recent ? now - recent.at : Infinity;
  const kickHit = recentAge < 180 && recent?.onsetClass === "kick" ? recent.strength || kickPulse : 0;
  const snareHit = recentAge < 180 && (recent?.onsetClass === "backbeat" || recent?.onsetClass === "mixed")
    ? recent.strength || 0 : 0;
  const flux = Number(realtimeAudioFeatures?.spectralFlux) || 0;
  const semantic = typeof getSemanticState === "function" ? getSemanticState() : {};
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  const live = typeof hasCurrentAudioSignal === "function" ? hasCurrentAudioSignal() : audioStarted;

  window.parent.postMessage({
    type: "music-shower:audio-features",
    streamId: semantic.sessionId || "",
    trackEpoch: lifecycle ? lifecycle.getTrackEpoch() : Number(semantic.trackEpoch) || 0,
    timestamp: Date.now(),
    live,
    features: {
      kick: Math.max(0, Math.min(1, kickPulse * 0.65 + kickHit * 0.7 + (bands.subBass || 0) * 1.5)),
      snare: Math.max(0, Math.min(1, snareHit + (bands.mid || 0) * 0.85)),
      bass: Math.max(0, Math.min(1, ((bands.subBass || 0) + (bands.bass || 0)) * 1.15)),
      high: Math.max(0, Math.min(1, ((bands.highMid || 0) + (bands.brilliance || 0) + (bands.air || 0)) * 0.9)),
      rms,
      transient: Math.max(0, Math.min(1, flux * 8 + kickPulse * 0.35)),
      vocal: Math.max(0, Math.min(1, (bands.lowMid || 0) * 0.45 + (bands.mid || 0) * 0.8))
    }
  }, parentOrigin);
}

function draw() {
  if (audioStarted) {
    updateAudioData();
    updateBeatDetection();
    updateSemanticRuntime(performance.now());
    updateWordSpawner();
    publishAudioFeaturesToParent();
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
  const lifecycle = typeof getTrackLifecycleEngine === "function" ? getTrackLifecycleEngine() : null;
  const reservoir = typeof getFlamingoWordReservoir === "function" ? getFlamingoWordReservoir() : null;
  let statusText = labels[state.status] || labels[state.ml.status] || "로컬 분석 준비";
  if (lifecycle) {
    statusText += ` · [${lifecycle.getState()} e:${lifecycle.getTrackEpoch()}]`;
    if (reservoir && reservoir.conceptRegistry.size > 0) {
      statusText += ` · 🦩${reservoir.conceptRegistry.size}`;
    }
  }
  text(statusText, width - 24, 24);
  pop();
}

function keyPressed() {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (key === "d" || key === "D") {
    CONFIG.semantic.debug = !CONFIG.semantic.debug;
    document.body.classList.toggle("semanticDebug", CONFIG.semantic.debug);
  }
  if (key === "l" || key === "L") LanguageInspector.toggle();
  if (key === "t" || key === "T") TrackStatusInspector.toggle();
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
