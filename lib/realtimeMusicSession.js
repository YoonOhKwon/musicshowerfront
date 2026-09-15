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
const EnglishSurface = require("./englishSurface");
const Grounded = require("./groundedAssociation");
const { analyzeLoopEvidence } = require("./loopEvidence");

// A Flamingo process that is still loading its model (503) or not listening yet would otherwise
// cost a whole cadence interval; retry the latest audio soon instead.
const FLAMINGO_RETRY_MS = 10000;
const RETRYABLE_FLAMINGO = new Set(["FLAMINGO_LOADING", "FLAMINGO_OFFLINE"]);
const DISPLAY_WINDOW_MS = 60000;
// Untranslated phrases are retried at most this often, so a failing API cannot be hammered.
const ENGLISH_RETRY_MS = 30000;
// New local phrases arrive a few per second at the start of a track; translating them as they appear
// cost 9 calls in the first 45 seconds. Collect for a few seconds and translate them together.
const ENGLISH_BATCH_MS = 4000;
// A new association call needs this much new listening evidence (unless the tier, the primary
// genre, or a forensic/measurement consensus changed).
const NEW_EVIDENCE_FOR_ASSOCIATION = 3;

const countBy = (items, key) => items.reduce((acc, item) => {
  const name = key(item) || "unknown";
  acc[name] = (acc[name] || 0) + 1;
  return acc;
}, {});

class RealtimeMusicSession {
  constructor({ streamId, send, analyze, realize, inferModels = null, translate = null, associate = null,
    associationsOnScreen = false, forensicListening = false, englishBatchMs = ENGLISH_BATCH_MS,
    llmProviders = null, defaultLlmProvider = "openai" }) {
    // associationsOnScreen: grounded associations join the display pool instead of the inspector only.
    // forensicListening: after each realized capture, ask Flamingo short questions about how the
    // recording was made (sampling, loops, vocals, source period) as grounded-association evidence.
    Object.assign(this, { streamId, send, analyze, realize, inferModels, translate, associate, associationsOnScreen,
      forensicListening, englishBatchMs });
    // English surfaces are only fetched while the client displays English words.
    this.wordLanguage = "ko";
    // Opt-in per audio connection. Missing/legacy clients must never enable paid hooks.
    this.tokenMode = "free";
    // Which language-model provider answers token mode (openai / gemini). null = accept any
    // provider id (tests and embedders without a provider registry).
    this.llmProviders = Array.isArray(llmProviders) ? llmProviders : null;
    this.defaultLlmProvider = defaultLlmProvider;
    this.llmProvider = defaultLlmProvider;
    this.english = new Map();
    this.englishInFlight = false;
    this.englishRetryAt = 0;
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
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
      // Track-scoped variety measurements for the front3 inspector.
      this.diversity = { conceptKeys: new Set(), shown: [], lastPacket: null };
      // Grounded culture/era/imagery/aesthetic associations for this track.
      this.association = { cues: new Map(), items: [], tier: null, primary: null, inFlight: false,
        calls: 0, proposed: 0, accepted: 0, rejected: {}, lastError: null,
        forensics: [], measurements: [], forensicCalls: 0, forensicError: null,
        lastSignatures: null, lastTier: null, lastPrimary: null };
    }
  }

  start({ sampleRate = 16000, format = "f32le", channels = 1, tokenMode = "free", llmProvider = this.defaultLlmProvider } = {}) {
    if (!["free", "token"].includes(tokenMode)) {
      return this.send({ type: "error", code: "INVALID_TOKEN_MODE", message: "토큰 모드를 다시 선택해 주세요." });
    }
    const provider = String(llmProvider || this.defaultLlmProvider).toLowerCase();
    if (tokenMode === "token" && this.llmProviders && !this.llmProviders.includes(provider)) {
      return this.send({ type: "error", code: "LLM_PROVIDER_UNAVAILABLE",
        message: `${provider === "gemini" ? "Gemini" : "OpenAI"} API 키가 서버에 설정되어 있지 않습니다.` });
    }
    if (this.started && (tokenMode !== this.tokenMode || (tokenMode === "token" && provider !== this.llmProvider))) {
      return this.send({ type: "error", code: "TOKEN_MODE_LOCKED", message: "모드 변경은 연결을 종료한 뒤 다시 연결해 주세요." });
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || format !== "f32le" || channels !== 1) {
      return this.send({ type: "error", message: "지원하지 않는 오디오 형식입니다." });
    }
    if (!this.started) this.reset(sampleRate);
    else if (this.sampleRate !== sampleRate) return this.send({ type: "error", message: "오디오 형식이 변경되었습니다. 다시 연결해 주세요." });
    this.tokenMode = tokenMode;
    this.llmProvider = provider;
    this.started = true;
    this.send({ type: "started", streamId: this.streamId, trackEpoch: this.trackEpoch,
      sampleRate: this.sampleRate, poolSource: "music-shower-final", tokenMode: this.tokenMode,
      llmProvider: this.tokenMode === "token" ? this.llmProvider : null });
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
    if (this.tokenMode === "free") {
      // Keep untranslated, independently heard concepts visible without inventing Korean prose.
      this.state.flamingoReservoirCandidates = this.state.flamingoReservoirCandidates.map(item =>
        ({ ...item, requiresKoreanRealization: false }));
    }
    this.state.groundedAssociationCandidates = this.associationsOnScreen
      ? Grounded.displayableAssociations(this.association.items, this.state).map(Grounded.toCandidate) : [];
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
      const diagnostics = result.structuredPacket?.packetDiagnostics;
      this.diversity.lastPacket = diagnostics ? { accepted: diagnostics.acceptedConceptCount,
        rejected: diagnostics.duplicateOrRejectedCount, quarantined: diagnostics.quarantinedCount,
        fields: diagnostics.fieldCounts } : { accepted: Flamingo.packetConceptCount(packet) };
      this.genreFusion.ingest(result.observations || []);
      this.collectStyleCues(result.structuredPacket?.styleCues);
      this.recordMeasurement(capture.samples);
      this.lastError = null;
      this.status = "realizing";
      await this.project();
      const concepts = [...this.reservoir.conceptRegistry.values()].filter(item => item.observationId === result.observationId)
        .map(item => ({ text: item.canonicalText, category: item.category, layer: item.layer }));
      const realized = this.tokenMode === "token"
        ? await this.realize({ concepts, sessionId: this.streamId, trackEpoch: this.trackEpoch }, controller.signal)
        : { realizationItems: [], failures: [] };
      if (!current()) return;
      for (const item of realized.realizationItems || []) {
        this.reservoir.applyRealization(item.text, item.family, item.category);
      }
      this.status = "listening";
      this.lastError = realized.failures?.length ? { stage: "realization", message: realized.failures[0].message } : null;
      await this.project();
      if (this.tokenMode === "token" && this.forensicListening) {
        await this.forensicListen(controller, current);
        if (!current()) return;
      }
      this.requestAssociation();
    } catch (error) {
      if (current()) {
        this.reportError("flamingo", error);
        this.scheduleRetry(capture, error);
      }
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

  scheduleRetry(capture, error) {
    if (!RETRYABLE_FLAMINGO.has(error?.code) || this.retryTimer) return;
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed || generation !== this.generation || !this.live || this.scheduler.active) return;
      this.listen({ ...capture, samples: this.buffer.snapshot(), activeAudioMs: this.activeAudioMs });
    }, FLAMINGO_RETRY_MS);
    this.retryTimer.unref?.();
  }

  noteUsed({ text, trackEpoch }) {
    if (trackEpoch !== this.trackEpoch) return;
    this.diversity.shown.push({ text: String(text || ""), at: Date.now() });
    if (!this.live) return;
    const token = this.tokens.find(item => item.text === text);
    if (!token) return;
    this.pool.noteUsed(text);
    this.reservoir.noteUsed(text, token.surfaceConceptKey);
    this.project();
  }

  reportError(stage, error) {
    if (this.closed) return;
    this.lastError = { stage, message: String(error.message || error).slice(0, 160) };
    if (error?.code) this.lastError.code = error.code;
    this.status = "degraded";
    this.publish(true);
  }

  diversitySnapshot(tokens) {
    const { diversity } = this;
    for (const token of tokens) diversity.conceptKeys.add(token.surfaceConceptKey || token.canonicalText || token.text);
    const cutoff = Date.now() - DISPLAY_WINDOW_MS;
    diversity.shown = diversity.shown.filter(entry => entry.at >= cutoff);
    const distinctShown = new Set(diversity.shown.map(entry => entry.text)).size;
    return {
      conceptsSeen: diversity.conceptKeys.size,
      layers: countBy(tokens, token => token.layer),
      flamingoTokens: tokens.filter(token => token.sourceFamily === "directAudio").length,
      flamingoCategories: countBy([...this.reservoir.conceptRegistry.values()], entry => entry.category),
      shownLastMinute: diversity.shown.length,
      repeatShareLastMinute: diversity.shown.length
        ? Number(((diversity.shown.length - distinctShown) / diversity.shown.length).toFixed(2)) : 0,
      lastPacket: diversity.lastPacket
    };
  }

  collectStyleCues(cues) {
    for (const cue of Array.isArray(cues) ? cues : []) {
      const text = String(cue?.text || "").trim();
      const key = text.toLowerCase();
      if (!text) continue;
      const existing = this.association.cues.get(key);
      if (existing) {
        existing.count += 1;
        existing.confidence = Math.max(existing.confidence, Number(cue.confidence) || 0);
      } else {
        this.association.cues.set(key, { text, confidence: Number(cue.confidence) || 0.5, count: 1 });
      }
    }
  }

  recordMeasurement(samples) {
    const result = analyzeLoopEvidence(samples, this.sampleRate);
    if (result) this.association.measurements = [...this.association.measurements, result].slice(-8);
  }

  async forensicListen(controller, current) {
    const association = this.association;
    const sequence = association.forensicCalls + 1;
    this.status = "forensic";
    this.publish(true);
    try {
      const result = await this.analyze({ samples: this.buffer.snapshot(), sampleRate: this.sampleRate,
        trackEpoch: this.trackEpoch, generation: this.generation, activeAudioMs: this.activeAudioMs,
        firstImpression: false, listenDepth: "forensic", signal: controller.signal, sessionId: this.streamId,
        segmentId: `forensic-${sequence}`, requestId: `${this.streamId}-${this.generation}-forensic-${sequence}` });
      if (!current() || this.association !== association) return;
      association.forensicCalls = sequence;
      if (Array.isArray(result?.forensics) && result.forensics.length) {
        association.forensics = [...association.forensics, result.forensics].slice(-6);
      }
      association.forensicError = null;
    } catch (error) {
      if (current()) association.forensicError = String(error.message || error).slice(0, 160);
    } finally {
      if (current()) this.status = "listening";
    }
  }

  // Whether the evidence has moved enough to pay for another association call.
  associationWanted({ tier, primary, signatures }) {
    const association = this.association;
    if (!association.lastSignatures) return true;
    if (tier !== association.lastTier || (primary?.label || null) !== association.lastPrimary) return true;
    const fresh = [...signatures].filter(signature => !association.lastSignatures.has(signature));
    if (fresh.some(signature => /^(forensic|measurement):/.test(signature))) return true;
    return fresh.length >= NEW_EVIDENCE_FOR_ASSOCIATION;
  }

  // One grounded association call per new body of evidence: after a capture is realized, or when
  // the genre resolution tier changes. The language model output is validated before it is kept.
  requestAssociation() {
    if (this.tokenMode !== "token") return;
    const association = this.association;
    if (!this.associate || association.inFlight || this.closed) return;
    const production = Grounded.productionConsensus(association);
    const { tier, primary } = Grounded.resolutionTier(this.state, production);
    const concepts = [...this.reservoir.conceptRegistry.values()].map(entry => ({
      canonicalText: entry.canonicalText, category: entry.category, layer: entry.layer,
      confidence: entry.confidence, segments: entry.segmentIds?.size || 1 }));
    const cues = [...association.cues.values()];
    if (!concepts.some(entry => entry.category !== "genre") && !cues.length) return;
    const evidence = Grounded.buildEvidence({ state: this.state, concepts, cues, production });
    const signatures = new Set(evidence.filter(item => !["genre", "classifier"].includes(item.kind)).map(item => item.signature));
    if (!this.associationWanted({ tier, primary, signatures })) return;
    const previous = { lastSignatures: association.lastSignatures, lastTier: association.lastTier, lastPrimary: association.lastPrimary };
    Object.assign(association, { inFlight: true, tier, primary,
      lastSignatures: signatures, lastTier: tier, lastPrimary: primary?.label || null });
    const controller = new AbortController();
    this.controllers.add(controller);
    const alreadyShown = association.items.flatMap(item => [item.text, item.textEn]);
    Promise.resolve()
      .then(() => this.associate({ evidence, tier, alreadyShown }, controller.signal))
      .then(result => {
        if (this.closed || this.association !== association) return;
        association.calls += 1;
        association.proposed += result.proposed || 0;
        association.accepted += result.accepted?.length || 0;
        for (const [reason, count] of Object.entries(result.rejected || {})) {
          association.rejected[reason] = (association.rejected[reason] || 0) + count;
        }
        association.items = [...association.items, ...(result.accepted || []).map(item => ({ ...item, tier }))].slice(-60);
        association.lastError = null;
        if (this.associationsOnScreen) this.project();
        this.publish(true);
      })
      .catch(error => {
        if (controller.signal.aborted || this.association !== association) return;
        association.lastError = String(error.message || error).slice(0, 160);
        Object.assign(association, previous);
        this.publish(true);
      })
      .finally(() => {
        this.controllers.delete(controller);
        association.inFlight = false;
      });
  }

  associationSnapshot() {
    const association = this.association;
    const production = Grounded.productionConsensus(association);
    if (association.calls > 0 && !association.inFlight) {
      const { tier } = Grounded.resolutionTier(this.state, production);
      if (tier !== association.tier) this.requestAssociation();
    }
    return {
      production: { answers: production.answers, loop: production.loop, sidechain: production.sidechain,
        tempoBpm: production.tempoBpm, maxLoopRepetition: production.maxLoopRepetition,
        corroborated: production.corroborated, forensicCalls: association.forensicCalls,
        forensicError: association.forensicError, lastMeasurement: association.measurements.at(-1) || null },
      tier: association.tier, primary: association.primary, pending: association.inFlight,
      calls: association.calls, proposed: association.proposed, accepted: association.accepted,
      rejected: association.rejected, lastError: association.lastError,
      styleCues: [...association.cues.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(cue => cue.text),
      items: association.items.map(item => ({ category: item.category, text: item.text, textEn: item.textEn,
        specificity: item.specificity, tier: item.tier, anchors: item.anchors.map(anchor => anchor.text) }))
    };
  }

  setWordLanguage(language) {
    const next = language === "en" ? "en" : "ko";
    if (next === this.wordLanguage) return;
    this.wordLanguage = next;
    this.publish(true);
  }

  requestEnglish(tokens) {
    if (this.tokenMode !== "token") return;
    if (!this.translate || this.englishInFlight || Date.now() < this.englishRetryAt) return;
    if (!tokens.some(token => !token.textEn)) return;
    if (!this.englishBatchMs) return this.flushEnglish();
    if (this.englishTimer) return;
    this.englishTimer = setTimeout(() => {
      this.englishTimer = null;
      this.flushEnglish();
    }, this.englishBatchMs);
    this.englishTimer.unref?.();
  }

  flushEnglish() {
    if (this.tokenMode !== "token" || this.closed || this.wordLanguage !== "en" || this.englishInFlight) return;
    const items = this.tokens
      .filter(item => !(item.textEn || EnglishSurface.directEnglishSurface(item) || this.english.get(item.text)))
      .map(({ text, layer }) => ({ text, layer }));
    if (!items.length) return;
    this.englishInFlight = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    Promise.resolve()
      .then(() => this.translate({ items }, controller.signal))
      .then(({ translations = {} } = {}) => {
        if (this.closed) return;
        for (const [text, english] of Object.entries(translations)) this.english.set(text, english);
        if (items.some(item => !this.english.has(item.text))) this.englishRetryAt = Date.now() + ENGLISH_RETRY_MS;
        this.publish();
      })
      .catch(() => {
        if (!controller.signal.aborted) this.englishRetryAt = Date.now() + ENGLISH_RETRY_MS;
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.englishInFlight = false;
      });
  }

  publish(force = false) {
    if (!this.started || this.closed) return;
    const tokens = this.tokens.map(item => ({ text: item.text, layer: item.layer,
      textEn: item.textEn || (EnglishSurface.directEnglishSurface(item) ?? this.english.get(item.text)),
      category: item.associationCategory || item.category,
      type: item.type || "fragment", glow: item.glow || 1,
      source: item.source, sourceFamily: item.sourceFamily, sourceModel: item.sourceModel,
      canonicalText: item.canonicalText, surfaceConceptKey: item.surfaceConceptKey }));
    if (this.wordLanguage === "en") this.requestEnglish(tokens);
    const signature = JSON.stringify({ tokens, live: this.live, status: this.status,
      localModel: this.modelStatus, error: this.lastError });
    if (!force && this.signature === signature) return;
    this.signature = signature;
    this.send({ type: "word_pool", streamId: this.streamId, trackEpoch: this.trackEpoch,
      revision: ++this.revision, semanticEpoch: this.state.semanticEpoch, updatedAt: Date.now(),
      poolSource: "music-shower-final", live: this.live, tokens,
      analysis: { status: this.status, activeAudioMs: this.activeAudioMs,
        tokenMode: this.tokenMode, llmProvider: this.tokenMode === "token" ? this.llmProvider : null,
        openAIEnabled: this.tokenMode === "token" && this.llmProvider === "openai",
        llmEnabled: this.tokenMode === "token",
        localModel: this.modelStatus,
        captures: this.reservoir.packetCount, concepts: this.reservoir.conceptRegistry.size,
        nextCaptureAtMs: this.scheduler.cadenceDueAtMs(), error: this.lastError,
        diversity: this.diversitySnapshot(tokens), association: this.associationSnapshot() } });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.englishTimer);
    this.englishTimer = null;
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.buffer.reset();
  }
}

module.exports = { RealtimeMusicSession };
