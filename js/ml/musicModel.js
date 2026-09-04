class MusicModelBridge {
  constructor(config = {}) {
    this.config = config;
    this.worker = null;
    this.state = { status: "idle", backend: "none", latencyMs: 0, timings: {}, error: null };
    this.inFlight = null;
    this.pending = null;
    this.sequence = 0;
    this.manifest = null;
    this.sharedRing = null;
  }

  async initialize() {
    this.state = { ...this.state, status: "loading", error: null };
    try {
      const manifest = await MusicModelLoader.loadManifest(this.config.manifestUrl);
      this.manifest = manifest;
      const validation = MusicModelLoader.validateManifest(manifest);
      if (!validation.valid) {
        this.state = { ...this.state, status: "fallback", error: validation.reason };
        return this.state;
      }
      const backend = await MusicModelLoader.selectInferenceBackend(this.config.backendPreference);
      if (backend === "unavailable") throw new Error("noInferenceBackend");
      this.worker = new Worker(this.config.workerUrl);
      this.worker.addEventListener("message", event => this.handleMessage(event.data));
      this.worker.addEventListener("error", error => this.fail(error.message || "workerFailed"));
      this.worker.postMessage({ type: "init", manifest, backend });
      this.state = { ...this.state, status: "loading", backend };
    } catch (error) {
      this.fail(error.message || "modelLoadFailed");
    }
    return this.state;
  }

  infer(audio, sessionId, sourceSampleRate, analysisWindowId = 0) {
    if (this.state.status !== "ready" || !this.worker || !audio?.length) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const task = { id: ++this.sequence, sessionId, analysisWindowId, audio, sourceSampleRate, resolve, reject, queuedAt: performance.now() };
      if (this.inFlight) {
        if (this.pending) this.pending.resolve(null);
        this.pending = task;
      } else {
        this.dispatch(task);
      }
    });
  }

  attachSharedRing(descriptor) {
    this.sharedRing = descriptor || null;
    if (this.worker && this.state.status === "ready" && this.sharedRing) {
      this.worker.postMessage({ type: "set-shared-ring", descriptor: this.sharedRing });
    }
  }

  inferShared(seconds, sessionId, sourceSampleRate, analysisWindowId = 0) {
    if (this.state.status !== "ready" || !this.worker || !this.sharedRing) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const task = { id: ++this.sequence, sessionId, analysisWindowId, shared: true, seconds, sourceSampleRate,
        resolve, reject, queuedAt: performance.now() };
      if (this.inFlight) {
        if (this.pending) this.pending.resolve(null);
        this.pending = task;
      } else this.dispatch(task);
    });
  }

  dispatch(task) {
    this.inFlight = task;
    task.dispatchedAt = performance.now();
    const transferStartedAt = performance.now();
    const message = {
      type: "infer",
      id: task.id,
      sessionId: task.sessionId,
      analysisWindowId: task.analysisWindowId,
      audio: task.audio,
      shared: Boolean(task.shared),
      seconds: task.seconds,
      sourceSampleRate: task.sourceSampleRate,
      dispatchedAt: task.dispatchedAt
    };
    if (task.shared) this.worker.postMessage(message);
    else this.worker.postMessage(message, [task.audio.buffer]);
    task.transferDispatchMs = performance.now() - transferStartedAt;
  }

  handleMessage(message) {
    if (message.type === "ready") {
      this.state = { status: "ready", backend: message.backend, latencyMs: 0, timings: {}, error: null, manifest: message.manifest };
      if (this.sharedRing) this.worker?.postMessage({ type: "set-shared-ring", descriptor: this.sharedRing });
      return;
    }
    if (message.type === "failed") {
      this.fail(message.error || "modelFailed");
      return;
    }
    if (message.type !== "result" || !this.inFlight || message.id !== this.inFlight.id) return;
    const task = this.inFlight;
    this.inFlight = null;
    const completedAt = performance.now();
    this.state.latencyMs = message.latencyMs || completedAt - task.queuedAt;
    this.state.timings = {
      ...(message.timings || {}),
      queueMs: Math.max(0, (task.dispatchedAt || task.queuedAt) - task.queuedAt),
      transferDispatchMs: task.transferDispatchMs || 0,
      roundTripMs: completedAt - (task.dispatchedAt || task.queuedAt)
    };
    this.state.error = message.error || null;
    task.resolve(message);
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      this.dispatch(pending);
    }
  }

  fail(error) {
    this.state = { ...this.state, status: "fallback", error: String(error) };
    this.inFlight?.resolve(null);
    this.pending?.resolve(null);
    this.inFlight = null;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }

  resetSession() {
    if (this.pending) this.pending.resolve(null);
    this.pending = null;
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = MusicModelBridge;
