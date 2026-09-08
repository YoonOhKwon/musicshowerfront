const PhrasePool = (() => {
  const Snapshot = typeof SemanticSnapshot !== "undefined" ? SemanticSnapshot : require("./semanticSnapshot");
  const Critic = typeof LanguageCritic !== "undefined" ? LanguageCritic : require("./languageCritic");
  const Expressions = typeof MusicExpressionEngine !== "undefined" ? MusicExpressionEngine : require("./musicExpressionEngine");
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Manager = typeof SemanticFacetManager !== "undefined" ? SemanticFacetManager : require("./semanticFacetManager");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const ReservoirModule = typeof CandidateReservoir !== "undefined" ? CandidateReservoir : require("./candidateReservoir");
  const EvidenceModule = typeof EvidenceReservoir !== "undefined" ? EvidenceReservoir : require("./evidenceReservoir");
  const ProfileModule = typeof SongLanguageProfile !== "undefined" ? SongLanguageProfile : require("./songLanguageProfile");
  const Scheduler = typeof WordPoolScheduler !== "undefined" ? WordPoolScheduler
    : (typeof require === "function" ? require("./wordPoolScheduler") : null);
  const GENERIC = Critic.GENERIC;
  const clone = value => JSON.parse(JSON.stringify(value));
  const similarity = Critic.similarity;
  const emptyTokenUsage = () => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheHitRate: 0 });
  const layerCounts = list => Object.fromEntries(Layers.names.map(layer =>
    [layer, (list || []).filter(item => Layers.decorate(item).layer === layer).length]));
  const factSourceCounts = list => {
    const sources = ["primitive", "primitive-observation", "idiom", "rhythm", "instrument", "production", "arrangement",
      "fact-composition", "live-event", "local-grammar", "aesthetic-induction"];
    return Object.fromEntries(sources.map(source => [source, (list || []).filter(item =>
      Layers.decorate(item).layer === "FACT" && item.source === source).length]));
  };
  const relationCounts = list => {
    const families = ["PRIMARY_GENRE", "PARENT", "LINEAGE", "ADJACENCY", "ERA", "SCENE", "CULTURE", "ARTIST",
      "SOURCE", "INFLUENCE", "RHYTHMIC_AFFINITY", "COMPOSITION", "AESTHETIC_ASSOCIATION"];
    return Object.fromEntries(families.map(family => [family, (list || []).filter(item => Quality.relationFamily(item) === family).length]));
  };
  const CREATIVE_EVENT_PATH = /^(?:primaryGenre|genreFamily|currentSection\.(?:state|novelty)|instrumentEvents|performance\.(?:soloInstrument|leadInstrument|bassFunction)|arrangement\.(?:densityDelta|layerEntry|layerExit|foregroundChange|instrumentRoleChange)|impressionConcepts)/;
  const meaningfulCreativeDelta = value => Boolean(value?.changes?.some(change => CREATIVE_EVENT_PATH.test(change.path)));
  const audioIsAudible = state => state?.expressionFeatures?.audible !== false ||
    (typeof hasCurrentAudioSignal === "function" && hasCurrentAudioSignal()) ||
    (typeof getSoundCloudPlaybackState === "function" && getSoundCloudPlaybackState()?.transport === "playing");

  function isAcceptable(text, context = {}) {
    const clean = Critic.normalize(text);
    return Boolean(Critic.validExpression(clean, Critic.categoryFor(clean, context.category)));
  }
  function uniqueCandidates(candidates, context = {}, limit = 40) {
    return Critic.rank(candidates, { context, limit }).selected;
  }
  function buildSeed(state = {}) { return { state }; }
  // Compatibility hook: a bounded literal pool, never combinatorial imagery.
  function structuredCandidates(seed = {}, semanticTokens = [], count = 40) {
    return Manager.local(seed.state || { trackCharacter: seed }).slice(0, count);
  }

  class LRUCache {
    constructor(limit = 16) { this.limit = limit; this.map = new Map(); }
    get(key) {
      const value = this.map.get(key);
      if (!value) return null;
      this.map.delete(key); this.map.set(key, value);
      return clone(value);
    }
    set(key, value) {
      this.map.delete(key); this.map.set(key, clone(value));
      while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    }
    clear() { this.map.clear(); }
  }

  class Engine {
    constructor({ provider = null, generator = null, fallbackProvider = null, ranker = null, poolSize = 36,
      minimumIntervalMs = 45000, stableDelayMs = 5000, lowWatermark = 10, cacheSize = 16 } = {}) {
      this.provider = provider || generator;
      this.fallbackProvider = fallbackProvider;
      this.ranker = ranker;
      this.poolSize = Math.min(40, Math.max(25, poolSize));
      this.minimumIntervalMs = minimumIntervalMs;
      this.stableDelayMs = generator ? 0 : stableDelayMs;
      this.lowWatermark = lowWatermark;
      this.cache = new LRUCache(cacheSize);
      // Local candidates change much less often than the 500 ms semantic refresh cadence.
      // Cache critic output by the binned musical snapshot + concept set so the main thread
      // does not re-run every evidence/firewall check for acoustically equivalent states.
      this.localCriticCache = new Map();
      // Section 5: a coarser cache than this.cache above -- keyed by aesthetic-axis territory
      // (js/semantic/aestheticAxisEngine.js's axisSignature), not the exact snapshot fingerprint.
      // A ROUTINE pool top-up (reason "pool-low") that re-enters a territory already reached
      // recently, with local open-layer candidates already covering it, does not need a fresh
      // remote call -- see the gate in regenerate() below.
      this.axisSignatureCache = new Map();
      this.reservoir = new ReservoirModule.Reservoir({ capacity: this.poolSize });
      this.evidenceReservoir = new EvidenceModule.Reservoir({ capacity: 180 });
      this.songProfile = new ProfileModule.Profile();
      this.activeRequest = null;
      this.lastRequestAt = -Infinity;
      this.consecutiveFailures = 0;
      this.lastFailure = null;
      this.recent = [];
      this.worldHistory = [];
      this.reset(0);
    }

    // 1st failure waits 5s, 2nd 10s, 3rd 20s, 4th+ caps at 30-60s -- on top of (never below)
    // minimumIntervalMs. A clean success resets the streak immediately.
    //
    // The failure KIND matters as much as the count. Retrying a missing key or an exhausted credit
    // balance every 5 seconds cannot succeed and only fills the log, so those wait far longer while
    // the local engine keeps speaking.
    backoffMs() {
      if (this.consecutiveFailures <= 0) return this.minimumIntervalMs;
      const schedule = [5000, 10000, 20000, 30000, 45000, 60000];
      const step = schedule[Math.min(this.consecutiveFailures - 1, schedule.length - 1)];
      const failure = this.lastFailure || {};
      const floor = failure.retryable === false ? 600000 : failure.status === 429 ? 60000 : 0;
      return Math.max(this.minimumIntervalMs, step, floor);
    }

    reset(sessionId = 0) {
      // A track reset may keep the same semantic session and semantic epoch.  The session/epoch
      // pair therefore cannot identify an in-flight language request by itself: a late response
      // from Song A could otherwise be accepted after Song B has already reset the pool.  This
      // generation changes on every reset and is captured by regenerate() below.
      this.resetGeneration = (this.resetGeneration || 0) + 1;
      const tokenUsage = this.state?.tokenUsage || {
        request: emptyTokenUsage(), languageSession: emptyTokenUsage(), projectSession: emptyTokenUsage()
      };
      this.sessionId = sessionId;
      this.pool = [];
      this.reservoir.clear();
      this.evidenceReservoir.clear(sessionId);
      this.songProfile.reset(sessionId);
      this.latestState = {};
      this.installedAt = 0;
      this.recent = [];
      this.worldHistory = [];
      this.used = new Map();
      this.key = "";
      this.epoch = -1;
      this.desiredEpoch = -1;
      this.epochStartedAt = Date.now();
      this.hasRemotePool = false;
      this.lastSentSnapshot = null;
      this.consecutiveFailures = 0;
      this.cache.clear();
      this.localCriticCache.clear();
      this.axisSignatureCache.clear();
      this.state = { status: "fallback", provider: "live-expression", model: null, latencyMs: 0,
        phraseCount: 0, remaining: 0, fingerprint: "", artDirection: [], candidateCount: 0,
        selectedCount: 0, reason: "session-reset", cache: "miss", error: null, tokenUsage };
      this.lastInspection = { snapshot: null, artDirection: [], candidates: [], selected: [] };
      this.lastAssessed = null;
      this.lastSnapshot = [];
      this.inputRevision = 0;
      this.snapshotRevision = -1;
      this.currentSongProfile = this.songProfile.snapshot([]);
      // Do not clear activeRequest: a previous session may still own the network slot.
    }

    context(state) {
      const localCandidates = Manager.local(state);
      return { hasEvidence: audioIsAudible(state) && ((state.expressionFeatures?.sampleCount || 0) > 0 || (state.trackCharacter?.confidence || 0) > 0.12 || Boolean(state.ml?.lastUpdated)),
        snapshot: Snapshot.serialize(state, state.distinctive), eligibleTexts: localCandidates.map(item => item.text), localCandidates };
    }

    remaining() { return this.pool.filter(item => !this.used.has(item.text)).length; }

    rankLocal(candidates, context, limit = 80) {
      const signature = [this.desiredEpoch, context.snapshot?.fingerprint || "none", ...(candidates || []).map(item => {
        const normalized = Layers.decorate(item);
        const confidenceBand = Math.round((normalized.confidence || 0) * 20);
        return `${Quality.conceptKey(normalized)}:${normalized.layer}:${confidenceBand}:${(normalized.anchors || []).join(",")}`;
      })].join("|");
      const cached = this.localCriticCache.get(signature);
      if (cached) {
        this.localCriticCache.delete(signature);
        this.localCriticCache.set(signature, cached);
        return cached;
      }
      const ranked = Critic.rank(candidates, { context, limit });
      this.localCriticCache.set(signature, ranked);
      while (this.localCriticCache.size > 12) this.localCriticCache.delete(this.localCriticCache.keys().next().value);
      return ranked;
    }

    noteUsed(text) {
      this.used.set(text, (this.used.get(text) || 0) + 1);
      while (this.used.size > 96) this.used.delete(this.used.keys().next().value);
      this.recent = [...this.recent.filter(item => item !== text), text].slice(-32);
      this.reservoir.noteUsed(text);
      const candidate = this.lastSnapshot.find(item => item.text === text) || this.evidenceReservoir.find(text);
      if (candidate) {
        this.evidenceReservoir.noteDisplayed(candidate);
        this.songProfile.noteUsed(candidate);
      }
      this.state.remaining = this.remaining();
    }

    install(payload, epoch, source, reason, meta = {}) {
      this.installedAt = Date.now();
      this.generatedAt = payload.generatedAt || this.installedAt;
      this.sourceSnapshot = payload.snapshot;
      const decorated = payload.selected.slice(0, this.poolSize)
        .map(item => Layers.decorate({ ...item, epoch, source }))
        .filter(item => Manager.ownershipAllowed(item));
      this.pool = source === "remote-generative"
        ? this.reservoir.replace(decorated, { epoch, at: this.installedAt, defaultTtlMs: 60000 })
        : decorated;
      this.used.clear();
      this.key = payload.snapshot.fingerprint;
      this.epoch = epoch;
      this.hasRemotePool = source === "remote-generative";
      if (this.hasRemotePool) this.lastSentSnapshot = payload.snapshot;
      this.state = { ...this.state, status: this.hasRemotePool ? "ready" : "fallback", provider: source,
        phraseCount: this.pool.length, remaining: this.pool.length, fingerprint: this.key,
        artDirection: payload.artDirection || [], candidateCount: payload.candidates.length,
        selectedCount: this.pool.length, reason, cache: "miss", error: null, ...meta };
      this.lastInspection = { ...payload, selected: this.pool };
      this.snapshotRevision = -1;
    }

    fallback(state, semanticTokens, epoch, prepared = null) {
      const context = prepared || this.context(state);
      const selected = context.localCandidates;
      this.install({ selected, candidates: selected, artDirection: [], snapshot: context.snapshot },
        epoch, "live-expression", selected.length ? "current-audio" : "awaiting-audio", { error: this.state.error });
    }

    async regenerate({ state = {}, semanticTokens = [], sessionId = 0, epoch = 0, trackEpoch = 0, force = false } = {}) {
      if (sessionId !== this.sessionId) this.reset(sessionId);
      const now = Date.now();
      this.latestState = state;
      this.inputRevision++;
      const context = this.context(state);
      this.precomputed = { revision: this.inputRevision, context };
      if (epoch !== this.desiredEpoch) { this.desiredEpoch = epoch; this.epochStartedAt = now; }
      // A clearly changed epoch must not keep spawning the old track's language for an entire API wait.
      if (this.hasRemotePool && this.epoch !== epoch && now - this.epochStartedAt >= 5000) this.fallback(state, semanticTokens, epoch, context);
      // A new track deserves a fresher chance at the API, but a persistent outage (rate limit,
      // billing, downtime) will not be fixed by the track changing -- halve the streak, don't clear it.
      if (this.epoch !== epoch) this.consecutiveFailures = Math.floor(this.consecutiveFailures / 2);
      if (!this.hasRemotePool || !this.pool.length || now - this.installedAt > 60000) this.fallback(state, semanticTokens, epoch, context);
      const changed = this.epoch !== epoch;
      // Under the ownership contract the generic remote provider may return only CONTEXT. A
      // legitimate one-item context pool is complete, not "starved"; refill it when consumed,
      // rather than repeatedly asking the provider to manufacture forbidden layers.
      const contextOnlyRemote = this.hasRemotePool && this.pool.length > 0 &&
        this.pool.every(item => Layers.decorate(item).layer === "CONTEXT");
      const low = this.remaining() < (contextOnlyRemote ? 1 : this.lowWatermark);
      if (!context.hasEvidence || (state.expressionFeatures && state.expressionFeatures.observationSeconds < 20) || now - this.epochStartedAt < this.stableDelayMs) {
        this.state.status = "stabilizing";
        return this.snapshot();
      }
      const snapshot = context.snapshot;
      const semanticDelta = this.lastSentSnapshot ? Snapshot.delta(this.lastSentSnapshot, snapshot) : null;
      const eventDriven = force || meaningfulCreativeDelta(semanticDelta);
      const reason = changed ? "semantic-change" : eventDriven ? "semantic-event" :
        !this.hasRemotePool ? "initial-generation" : low ? "pool-low" : "pool-ready";
      if (this.hasRemotePool && !changed && !low && !eventDriven) return this.snapshot();
      // Section 5: an aesthetic-axis territory the local pool already covers does not need a
      // fresh remote call just for a ROUTINE top-up (reason "pool-low" -- the only reason value
      // reachable past the line above). semantic-change/semantic-event/initial-generation still
      // call through regardless: those need genre-specialization/phrasing variation the axis
      // engine alone cannot produce, not just open-layer gap-filling.
      const axisSignature = state.genreContextEvidence?.axisSignature || null;
      if (reason === "pool-low" && axisSignature) {
        // Specifically the axis-REGION vocabulary system's own output (data/aestheticRegions.json
        // matches), not any open-layer word from anywhere -- a bare single-trait mood descriptor
        // ("밝음", "공격적") from musicExpressionEngine.js is a different, much coarser source and
        // does not mean this axis TERRITORY has real vocabulary coverage.
        const hasLocalOpenLayerCoverage = context.localCandidates.some(item => item.source === "aesthetic-axis");
        const cachedForSignature = this.axisSignatureCache.get(axisSignature);
        if (hasLocalOpenLayerCoverage || (cachedForSignature && now - cachedForSignature.at < 300000)) {
          this.axisSignatureCache.set(axisSignature, { at: now });
          this.state = { ...this.state, reason };
          return this.snapshot();
        }
      }
      if (changed || !this.hasRemotePool) {
        const cached = this.cache.get(snapshot.fingerprint);
        if (cached && cached.selected.length > 0 && now - cached.generatedAt < 60000) {
          this.install(cached, epoch, "remote-generative", reason, { cache: "hit", latencyMs: 0,
            tokenUsage: { ...this.state.tokenUsage, request: emptyTokenUsage() } });
          return this.snapshot();
        }
      }
      if (!this.provider?.generate || this.provider.enabled === false) return this.snapshot();
      if (this.activeRequest) { this.state.status = "waiting"; return this.snapshot(); }
      if (now - this.lastRequestAt < this.backoffMs()) {
        this.state.status = "cooldown";
        this.state.reason = reason;
        return this.snapshot();
      }
      const resetGeneration = this.resetGeneration;
      const request = { sessionId, epoch, trackEpoch, resetGeneration };
      this.activeRequest = request;
      this.lastRequestAt = now;
      this.state = { ...this.state, status: "generating", reason, error: null, cache: "miss" };
      const input = { snapshot, recentPhrases: this.recent.slice(-24), recentArtDirections: this.worldHistory.slice(-6),
        candidateCount: 32, sessionId, trackEpoch, semanticEpoch: epoch, reason,
        songLanguageProfile: {
          dominantConcepts: (this.currentSongProfile?.dominantConcepts || []).slice(0, 12),
          alreadyUsedConcepts: (this.currentSongProfile?.recentConcepts || []).slice(-20),
          exhaustedConcepts: (this.currentSongProfile?.exhaustedConcepts || []).slice(0, 20),
          unexploredConcepts: (this.currentSongProfile?.unexploredConcepts || []).slice(0, 24),
          underrepresentedFacets: (this.currentSongProfile?.underrepresentedFacets || []).slice(0, 8)
        },
        requestMode: this.lastSentSnapshot ? "delta" : "baseline",
        baselineFingerprint: this.lastSentSnapshot?.fingerprint || null,
        stableContext: Snapshot.stableContext(snapshot),
        semanticDelta };
      const stillCurrent = () => this.sessionId === sessionId && this.desiredEpoch === epoch &&
        this.resetGeneration === resetGeneration && Date.now() - now < 60000;
      try {
        const generated = await this.provider.generate(input);
        if (!stillCurrent()) return this.snapshot();
        const candidates = Array.isArray(generated) ? generated : generated.candidates;
        if (!Array.isArray(candidates)) throw new Error("Malformed language candidates.");
        const latestContext = this.precomputed?.revision === this.inputRevision ? this.precomputed.context : this.context(this.latestState);
        const freshCandidates = candidates.filter(item => this.isFresh(item, snapshot, now, latestContext.snapshot));
        const options = { recent: this.recent.slice(), context: latestContext, limit: this.poolSize };
        const ranked = this.ranker ? await this.ranker.rank(freshCandidates, options) : Critic.rank(freshCandidates, options);
        if (!stillCurrent()) return this.snapshot();
        // Recorded even when the whole batch is rejected below, so a fully-discarded LLM
        // attempt still leaves a diagnostic trail instead of vanishing without a trace.
        this.lastAssessed = { assessed: ranked.assessed, epoch, at: now };
        const selected = uniqueCandidates(ranked.selected, latestContext, this.poolSize);
        if (!selected.length) throw new Error(`Only ${selected.length} candidates passed the critic; keeping the current pool.`);
        const artDirection = (generated.artDirection || []).slice(0, 4);
        const payload = { snapshot, candidates: ranked.assessed, selected, artDirection, generatedAt: now };
        this.cache.set(snapshot.fingerprint, payload);
        this.worldHistory = [...this.worldHistory, ...artDirection].slice(-12);
        this.install(payload, epoch, "remote-generative", reason, {
          latencyMs: Date.now() - now, model: generated.meta?.model || this.provider.state?.model || null,
          usage: generated.meta?.usage || null, tokenUsage: generated.meta?.tokenUsage || this.state.tokenUsage,
          cache: generated.meta?.cache || "miss" });
        this.lastSentSnapshot = snapshot;
        this.consecutiveFailures = 0;
        this.lastFailure = null;
      } catch (error) {
        if (stillCurrent()) {
          this.consecutiveFailures += 1;
          this.lastFailure = { status: error.status || null, code: error.code || null, retryable: error.retryable !== false };
          if (changed) this.fallback(state, semanticTokens, epoch, context);
          this.state = { ...this.state, status: "fallback", reason, error: String(error.message || error).slice(0, 180),
            errorCode: this.lastFailure.code, retryable: this.lastFailure.retryable,
            retryInMs: this.backoffMs(), consecutiveFailures: this.consecutiveFailures,
            tokenUsage: this.provider?.state?.meta?.tokenUsage || this.state.tokenUsage };
        }
      } finally {
        if (this.activeRequest === request) this.activeRequest = null;
      }
      return this.snapshot();
    }

    isFresh(item, source, generatedAt, current) {
      if (!source || !current) return false;
      const normalized = Layers.decorate(item);
      if (["CONTEXT", "AESTHETIC"].includes(normalized.layer) && source.primaryGenre !== current.primaryGenre) return false;
      if (Date.now() - generatedAt > Layers.ttlMs(normalized)) return false;
      if (Facets.volatile.has(normalized.category) || normalized.layer === "IMPRESSION") {
        for (const anchor of item.anchors || []) {
          const before = Facets.read(source, anchor), after = Facets.read(current, anchor);
          if (typeof before === "number" && typeof after === "number") {
            if (Math.abs(before - after) > Math.max(0.15, Math.abs(before) * 0.2)) return false;
          } else if (JSON.stringify(before) !== JSON.stringify(after)) return false;
          if (anchor.startsWith("instrumentation.observed.") &&
              JSON.stringify(source.instrumentation?.observed.map(x => x.id)) !== JSON.stringify(current.instrumentation?.observed.map(x => x.id))) return false;
          if (anchor.startsWith("instrumentEvents.") && JSON.stringify(source.instrumentEvents) !== JSON.stringify(current.instrumentEvents)) return false;
        }
      }
      return true;
    }

    snapshot() {
      const now = Date.now();
      if (this.snapshotRevision === this.inputRevision) {
        this.currentSongProfile = this.songProfile.snapshot(this.evidenceReservoir.snapshot({ at: now }), now);
        this.lastSnapshot = this.songProfile.annotate(this.lastSnapshot, now).map(item => ({
          ...item, useCount: this.used.get(item.text) || 0
        }));
        this.state.songLanguageProfile = this.currentSongProfile;
        this.state.evidenceReservoir = this.evidenceReservoir.stats(now);
        return this.lastSnapshot;
      }
      const prepared = this.precomputed?.revision === this.inputRevision ? this.precomputed.context : this.context(this.latestState);
      const live = prepared.localCandidates.map(item => Layers.decorate({ ...item, epoch: this.desiredEpoch }));
      const current = prepared;
      if (this.hasRemotePool) this.pool = this.reservoir.snapshot({ epoch: this.epoch });
      const enrichment = audioIsAudible(this.latestState) && this.hasRemotePool && this.epoch === this.desiredEpoch && Date.now() - this.installedAt < 60000
        ? Critic.rank(this.pool.filter(item => this.isFresh(item, this.sourceSnapshot, this.generatedAt, current.snapshot)), { context: current, limit: this.poolSize }).selected : [];
      // Revalidate every facet against current evidence; event words have a short lifetime.
      const merged = new Map(this.rankLocal(live, current, 80).selected.map(item => [Critic.semanticKey(item), item]));
      for (const item of enrichment) if (!merged.has(item.semanticKey)) merged.set(item.semanticKey, item);
      const observationSeconds = this.latestState.expressionFeatures?.observationSeconds ??
        (this.latestState.temporalEvidence?.elapsedMs || 0) / 1000;
      const evidence = this.evidenceReservoir.observe([...merged.values()], {
        sessionId: this.sessionId, epoch: this.desiredEpoch, at: now, observationSeconds
      });
      this.currentSongProfile = this.songProfile.observe(this.latestState, evidence, { sessionId: this.sessionId, at: now });
      // Reservoir history remains available for profiling, but only concepts accepted from the
      // CURRENT state are eligible for the screen. This avoids both stale contradictions and a
      // second full critic pass on the main thread.
      const currentConcepts = new Set([...merged.values()].map(item => Quality.conceptKey(item)));
      const currentEvidence = evidence.filter(item => currentConcepts.has(item.conceptKey));
      const curated = Manager.curate(currentEvidence, this.poolSize);
      this.lastSnapshot = this.songProfile.annotate(curated, now).map(item => ({
        ...item, useCount: this.used.get(item.text) || 0
      }));
      this.snapshotRevision = this.inputRevision;
      this.state.songLanguageProfile = this.currentSongProfile;
      this.state.evidenceReservoir = this.evidenceReservoir.stats(now);
      return this.lastSnapshot;
    }

    inspection() {
      const selected = this.snapshot();
      const localGenerated = Manager.base(this.latestState);
      const localContext = this.context(this.latestState);
      const localAccepted = Critic.rank(localGenerated, { context: localContext, limit: 100 }).selected;
      const known = new Set(selected.map(item => item.text));
      const installed = (this.lastInspection.candidates || []).filter(item => !known.has(item.text));
      for (const item of installed) known.add(item.text);
      // A batch that was entirely rejected never reaches lastInspection (install() is never
      // called), so fold in the last assessed attempt too — accepted or not — for diagnostics.
      const attempted = (this.lastAssessed?.assessed || []).filter(item => !known.has(item.text));
      const stages = { generated: localGenerated, criticAccepted: localAccepted,
        pooled: [...localAccepted, ...this.pool], selected };
      const survival = {
        layers: Object.fromEntries(Object.entries(stages).map(([stage, items]) => [stage, layerCounts(items)])),
        factSources: Object.fromEntries(Object.entries(stages).map(([stage, items]) => [stage, factSourceCounts(items)])),
        relationFamilies: Object.fromEntries(Object.entries(stages).map(([stage, items]) => [stage, relationCounts(items)]))
      };
      return clone({ ...this.lastInspection, state: { ...this.state, selectedCount: selected.length, survival,
        creativeReservoir: this.reservoir.stats(), evidenceReservoir: this.evidenceReservoir.stats(),
        songLanguageProfile: this.currentSongProfile },
        snapshot: Snapshot.serialize(this.latestState), selected,
        wordPoolDecision: Scheduler?.debugDecision?.() || { ranked: [], considered: 0 },
        candidates: [...selected, ...installed, ...attempted] });
    }
  }
  return { Engine, LRUCache, buildSeed, structuredCandidates, uniqueCandidates, similarity, isAcceptable, GENERIC };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PhrasePool;
