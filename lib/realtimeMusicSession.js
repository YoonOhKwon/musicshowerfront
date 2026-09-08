"use strict";

const { RealtimePcmAnalyzer } = require("./realtimePcmAnalyzer");
const { measureFrame } = require("./streamMeasurements");
const Expressions = require("../js/semantic/musicExpressionEngine");
const PhrasePool = require("../js/semantic/phrasePoolEngine");
const CandidatePipeline = require("../js/semantic/semanticCandidatePipeline");
const Arrangement = require("../js/semantic/arrangementEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Flamingo = require("../js/semantic/flamingoWordReservoir");
const Realizer = require("../js/semantic/directAudioRealizer");
const { AudibleAudioBuffer } = require("../js/audio/audibleAudioBuffer");
const { Scheduler } = require("../js/semantic/deepListenWindowScheduler");
const { StreamModelEvidence } = require("./streamModelEvidence");
const { StreamGenreFusion } = require("./streamGenreFusion");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const musicalLexicon = require("../data/musicalLexicon.json");

class RealtimeMusicSession {
  constructor({ streamId, send, analyze, realize, inferModels = null }) {
    Object.assign(this, { streamId, send, analyze, realize, inferModels });
    this.trackEpoch = 1;
    this.revision = 0;
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.identity = "";
    this.controllers = new Set();
    this.reset(16000);
  }

  reset(sampleRate, preservePool = false) {
    if (preservePool) this.accountForPause();
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.sampleRate = sampleRate;
    this.analyzer = new RealtimePcmAnalyzer({ sampleRate });
    this.buffer = new AudibleAudioBuffer(sampleRate, 30);
    this.history = new Expressions.FeatureHistory();
    this.modelEvidence = new StreamModelEvidence();
    this.modelBusy = false;
    this.lastModelAt = 0;
    this.modelStatus = { status: this.inferModels ? "waiting" : "disabled" };
    this.arrangement = new Arrangement.Engine();
    this.idioms = new Idioms.Engine(musicalLexicon, {
      primitiveSchema: Primitives.schema(),
      genreTaxonomy: {}
    });
    this.scheduler = new Scheduler({ trackEpoch: this.trackEpoch });
    this.activeAudioMs = 0;
    this.transport = "playing";
    this.live = false;
    this.silentAt = null;
    this.lastError = null;
    this.status = "listening";
    this.projection = null;
    this.projectAgain = false;
    if (!preservePool) {
      this.genreFusion = new StreamGenreFusion();
      this.reservoir = new Flamingo.Reservoir({ trackEpoch: this.trackEpoch, realizer: new Realizer.Realizer() });
      this.pool = new PhrasePool.Engine();
      this.state = { sessionId: this.streamId, trackEpoch: this.trackEpoch, semanticEpoch: 0,
        expressionFeatures: { audible: false, sampleCount: 0 }, audio: {}, trackCharacter: {},
        flamingoReservoirCandidates: [] };
      this.tokens = [];
    }
  }

  start({ sampleRate = 16000, format = "f32le", channels = 1 } = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || format !== "f32le" || channels !== 1) {
      return this.send({ type: "error", message: "지원하지 않는 오디오 형식입니다." });
    }
    if (!this.started) this.reset(sampleRate);
    else if (this.sampleRate !== sampleRate) return this.send({ type: "error", message: "오디오 형식이 변경되었습니다. 다시 연결해 주세요." });
    this.started = true;
    this.send({ type: "started", streamId: this.streamId, trackEpoch: this.trackEpoch,
      sampleRate: this.sampleRate, poolSource: "music-shower-final" });
    this.publish(true);
  }

  playback(message) {
    if (!this.started || this.closed) return;
    const event = message.event || message;
    const type = String(event.type || "").toUpperCase();
    const identity = String(event.identity || "").slice(0, 500);
    const changed = type === "TRACK_CHANGED" || (identity && this.identity && identity !== this.identity);
    if (identity) this.identity = identity;
    if (changed) {
      this.trackEpoch++;
      this.reset(this.sampleRate);
      this.send({ type: "track_changed", streamId: this.streamId, trackEpoch: this.trackEpoch });
      this.publish(true);
    } else if (type === "RESTART" || type === "RESTARTED") {
      // Same song, new capture window. Its confirmed concepts remain useful.
      this.reset(this.sampleRate, true);
    }
    if (["PAUSE", "PAUSED", "FINISH", "FINISHED", "ENDED"].includes(type)) {
      this.transport = "paused";
      this.live = false;
      this.silentAt ??= Date.now();
      this.publish(true);
    } else if (["PLAY", "PLAYING", "RESUMED", "PROGRESS", "RESTART", "RESTARTED"].includes(type)) {
      this.transport = "playing";
    }
  }

  push(samples) {
    if (!this.started || this.closed) return;
    if (samples.some(value => !Number.isFinite(value))) return;
    const result = this.analyzer.push(samples);
    const measurement = Expressions.measure(samples);
    const audible = this.transport !== "paused" && measurement.rms > 0.001;
    if (!audible) {
      this.silentAt ??= Date.now();
      if (this.live) { this.live = false; this.publish(true); }
    } else {
      if (this.silentAt !== null) {
        this.accountForPause();
        this.silentAt = null;
      }
      this.live = true;
      this.buffer.push(samples);
      this.activeAudioMs += samples.length / this.sampleRate * 1000;
      if (result) {
        const measured = measureFrame(this.buffer.snapshot().subarray(-Math.max(2048, samples.length)), this.sampleRate);
        this.state.expressionFeatures = this.history.update(measured, this.activeAudioMs);
        this.state.audio = measured;
        this.state.analysisWindow = this.history.summary();
        this.project();
      }
      if (this.scheduler.due(this.activeAudioMs)) {
        const firstImpression = this.scheduler.isFirstImpression();
        this.scheduler.markTriggered(this.activeAudioMs);
        const capture = { samples: this.buffer.snapshot(), sampleRate: this.sampleRate,
          trackEpoch: this.trackEpoch, generation: this.generation,
          requestGeneration: this.scheduler.requestGeneration,
          activeAudioMs: this.activeAudioMs, firstImpression };
        if (this.scheduler.active) this.scheduler.enqueuePending(capture);
        else this.listen(capture);
      }
      if (this.inferModels && !this.modelBusy && this.activeAudioMs - this.lastModelAt >= 3000 && this.buffer.seconds() >= 2.1) {
        this.infer();
      }
    }
    if (result) this.send({ type: "features", streamId: this.streamId, trackEpoch: this.trackEpoch,
      timestamp: Date.now(), live: this.live, features: this.live ? result.features : {} });
  }

  project() {
    if (this.closed) return Promise.resolve();
    if (this.projection) { this.projectAgain = true; return this.projection; }
    const generation = this.generation;
    const pool = this.pool;
    this.state.semanticEpoch++;
    this.accountForPause();
    this.state.flamingoReservoirCandidates = this.reservoir.getCandidates();
    this.genreFusion.apply(this.state);
    CandidatePipeline.populate(this.state, { arrangementEngine: this.arrangement, idiomEngine: this.idioms });
    this.projection = pool.regenerate({ state: this.state, sessionId: this.streamId,
      epoch: this.state.semanticEpoch, trackEpoch: this.trackEpoch, force: true })
      .then(() => {
        if (generation !== this.generation || this.closed) return;
        // This is the same final snapshot used by Music Shower's word spawner:
        // facets -> ownership gate -> critic -> diversity selection -> PhrasePool.
        this.tokens = pool.snapshot();
        this.publish();
      }).catch(error => {
        if (generation === this.generation) this.reportError("selection", error);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.projection = null;
        if (this.projectAgain) { this.projectAgain = false; this.project(); }
      });
    return this.projection;
  }

  accountForPause() {
    if (this.silentAt == null) return;
    const now = Date.now();
    // Also freeze TTL when a delayed analysis/translation finishes during pause.
    // A concept created halfway through the pause must not be shifted into the future.
    for (const entry of this.reservoir.conceptRegistry.values()) {
      for (const field of ["addedAt", "lastSeenAt"]) {
        entry[field] += Math.max(0, now - Math.max(this.silentAt, entry[field]));
      }
    }
    this.silentAt = now;
  }

  async infer() {
    this.modelBusy = true;
    this.lastModelAt = this.activeAudioMs;
    const generation = this.generation, at = this.activeAudioMs;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.modelStatus = { ...this.modelStatus, status: "analyzing" };
    try {
      const samples = this.buffer.snapshot().slice(-Math.ceil(this.sampleRate * 2.1));
      const result = await this.inferModels({ samples, sampleRate: this.sampleRate, signal: controller.signal });
      if (generation !== this.generation || this.closed) return;
      this.modelEvidence.apply(result, this.state, at);
      this.modelStatus = { status: "ready", model: result.model, observations: this.modelEvidence.observation };
      await this.project();
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.modelStatus = { status: "error", message: String(error.message || error).slice(0, 160) };
        this.publish(true);
      }
    } finally {
      this.controllers.delete(controller);
      if (generation === this.generation) this.modelBusy = false;
    }
  }

  async listen(capture) {
    const scheduler = this.scheduler;
    const sequence = scheduler.beginUpload();
    const controller = new AbortController();
    this.controllers.add(controller);
    const current = () => !this.closed && capture.generation === this.generation && !controller.signal.aborted;
    this.status = "analyzing";
    this.publish(true);
    try {
      const result = await this.analyze({ ...capture, signal: controller.signal,
        sessionId: this.streamId, segmentId: sequence,
        requestId: `${this.streamId}-${capture.generation}-${sequence}` });
      if (!current()) return;
      const packet = Flamingo.packetConceptCount(result.structuredPacket) ? result.structuredPacket
        : Flamingo.packetFromObservations(result.observations);
      this.reservoir.ingestPacket(packet, { trackEpoch: this.trackEpoch,
        observationId: result.observationId, audioSegmentId: String(sequence), listeningMode: "blind" });
      this.genreFusion.ingest(result.observations || []);
      this.lastError = null;
      this.status = "realizing";
      await this.project();
      const concepts = [...this.reservoir.conceptRegistry.values()].filter(item => item.observationId === result.observationId)
        .map(item => ({ text: item.canonicalText, category: item.category, layer: item.layer }));
      const realized = await this.realize({ concepts, sessionId: this.streamId, trackEpoch: this.trackEpoch }, controller.signal);
      if (!current()) return;
      for (const item of realized.realizationItems || []) {
        this.reservoir.applyRealization(item.text, item.family, item.category);
      }
      this.status = "listening";
      this.lastError = realized.failures?.length ? { stage: "realization", message: realized.failures[0].message } : null;
      await this.project();
    } catch (error) {
      if (current()) this.reportError("flamingo", error);
    } finally {
      this.controllers.delete(controller);
      scheduler.endUpload();
      if (current()) {
        this.publish(true);
        const pending = scheduler.takePending();
        if (pending) this.listen(pending);
      }
    }
  }

  noteUsed({ text, trackEpoch }) {
    if (trackEpoch !== this.trackEpoch || !this.live) return;
    const token = this.tokens.find(item => item.text === text);
    if (!token) return;
    this.pool.noteUsed(text);
    this.reservoir.noteUsed(text, token.surfaceConceptKey);
    this.project();
  }

  reportError(stage, error) {
    if (this.closed) return;
    this.lastError = { stage, message: String(error.message || error).slice(0, 160) };
    this.status = "degraded";
    this.publish(true);
  }

  publish(force = false) {
    if (!this.started || this.closed) return;
    const tokens = this.tokens.map(item => ({ text: item.text, layer: item.layer,
      type: item.type || "fragment", glow: item.glow || 1,
      source: item.source, sourceFamily: item.sourceFamily, sourceModel: item.sourceModel,
      canonicalText: item.canonicalText, surfaceConceptKey: item.surfaceConceptKey }));
    const signature = JSON.stringify({ tokens, live: this.live, status: this.status,
      localModel: this.modelStatus, error: this.lastError });
    if (!force && this.signature === signature) return;
    this.signature = signature;
    this.send({ type: "word_pool", streamId: this.streamId, trackEpoch: this.trackEpoch,
      revision: ++this.revision, semanticEpoch: this.state.semanticEpoch, updatedAt: Date.now(),
      poolSource: "music-shower-final", live: this.live, tokens,
      analysis: { status: this.status, activeAudioMs: this.activeAudioMs,
        localModel: this.modelStatus,
        captures: this.reservoir.packetCount, concepts: this.reservoir.conceptRegistry.size,
        nextCaptureAtMs: this.scheduler.cadenceDueAtMs(), error: this.lastError } });
  }

  close() {
    this.closed = true;
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.buffer.reset();
  }
}

module.exports = { RealtimeMusicSession };
