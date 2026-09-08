// Temporal memory for musical material. Stabilization is by canonical concept, not by
// the broad display category (rhythm / performance / ...). Independent materials that
// share a category stay alive; only mutually exclusive states compete.
const TemporalEvidence = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Axes = typeof EvidenceAxis !== "undefined" ? EvidenceAxis : require("./evidenceAxis");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const FAST = new Set(["live", "dynamics"]);
  const MUSICAL = new Set(["rhythm", "instrumentation", "performance", "arrangement", "production"]);
  const CONTEXT = new Set(["genre", "lineage", "mood", "era", "scene", "culture", "association"]);
  const keyFor = item => `${item.category}:${String(item.text).toLowerCase()}`;
  const rootsFor = item => Axes.independentAxes(item.anchors || []);

  const DOMAIN_CAPS = Object.freeze({
    rhythm: 4, drums: 3, bass: 3, harmony: 3, melody: 3, performance: 3,
    production: 4, form: 2, instrumentation: 3, arrangement: 2, dynamics: 2,
    genre: 3, context: 4, other: 3
  });

  const KNOWN_CONCEPTS = Object.freeze([
    { id: "rhythm.pulsePattern.four_on_floor", group: "rhythm.pulsePattern", domain: "rhythm",
      match: (text, concept) => /four_on_floor/.test(concept) || /4\/4|포\s*온|four.on.the.floor|four-on-the-floor/i.test(text) },
    { id: "rhythm.pulsePattern.two_step", group: "rhythm.pulsePattern", domain: "rhythm",
      match: (text, concept) => /two_step/.test(concept) || /2-?step|투스텝/i.test(text) },
    { id: "rhythm.pulsePattern.breakbeat", group: "rhythm.pulsePattern", domain: "rhythm",
      match: (text, concept) => /breakbeat/.test(concept) || /브레이크비트|breakbeat|amen/i.test(text) },
    { id: "rhythm.tempoClass.slow", group: "rhythm.tempoClass", domain: "rhythm",
      match: (text, concept) => /tempo_slow|very_slow/.test(concept) || /느린 템포|아주 느린 템포|slow tempo/i.test(text) },
    { id: "rhythm.tempoClass.fast", group: "rhythm.tempoClass", domain: "rhythm",
      match: (text, concept) => /tempo_fast|very_fast/.test(concept) || /빠른 템포|초고속 템포|fast tempo/i.test(text) },
    { id: "rhythm.syncopation", domain: "rhythm",
      match: (text, concept) => /syncop/.test(concept) || /싱코페이션|오프비트|syncop/i.test(text) },
    { id: "rhythm.subdivision", domain: "rhythm",
      match: (text, concept) => /subdivision/.test(concept) || /서브디비전|subdivision/i.test(text) },
    { id: "bass.motion.walking", group: "bass.motion", domain: "bass",
      match: (text, concept) => /walking/.test(concept) || /워킹 베이스|순차 진행 베이스|walking/i.test(text) },
    { id: "bass.motion.static", group: "bass.motion", domain: "bass",
      match: (text, concept) => /static_bass|bass_static/.test(concept) || /정적 베이스|static bass/i.test(text) },
    { id: "bass.repetition", domain: "bass",
      match: (text, concept) => /ostinato|bass_repetition/.test(concept) || /반복 베이스|오스티나토|ostinato/i.test(text) },
    { id: "bass.kickRelation", domain: "bass",
      match: (text, concept) => /kick/.test(concept) && /bass/.test(concept + text)
        || /킥과 베이스|킥-베이스|밀착된 하단|kick.?bass/i.test(text) },
    { id: "bass.rhythmicRole", domain: "bass",
      match: (text, concept) => /bass_syncop|syncopated_bass/.test(concept) || /싱코페이트.?베이스|베이스 싱코/i.test(text) },
    { id: "harmony.tonality.major", group: "harmony.tonality", domain: "harmony",
      match: (text, concept) => /major/.test(concept) || /장조/i.test(text) },
    { id: "harmony.tonality.minor", group: "harmony.tonality", domain: "harmony",
      match: (text, concept) => /minor/.test(concept) && !/major/.test(concept) || /단조/i.test(text) },
    { id: "harmony.harmonicRhythm", domain: "harmony",
      match: (text, concept) => /harmonic_rhythm|chord_change/.test(concept) || /화성 이동|화성 리듬|harmonic (?:motion|rhythm)/i.test(text) },
    { id: "harmony.tonality", domain: "harmony",
      match: (text, concept) => /tonal_center|tonality/.test(concept) || /조성 중심|tonal center/i.test(text) },
    { id: "melody.contour", domain: "melody",
      match: (text, concept) => /contour/.test(concept) || /상행|하행|선율|멜로디 윤곽|ascending|descending/i.test(text) },
    { id: "melody.motif", domain: "melody",
      match: (text, concept) => /motif/.test(concept) || /모티프|모티브|motif/i.test(text) },
    { id: "melody.phrase", domain: "melody",
      match: (text, concept) => /call_response|phrase/.test(concept) || /주고받는|콜 앤 리스폰스|프레이즈/i.test(text) },
    { id: "performance.comping", domain: "performance",
      match: (text, concept) => /comping/.test(concept) || /컴핑|comping/i.test(text) },
    { id: "production.dynamics", domain: "production",
      match: (text, concept) => /sidechain|pumping/.test(concept) || /사이드체인|펌핑/i.test(text) },
    { id: "production.sampling", domain: "production",
      match: (text, concept) => /sample/.test(concept) || /샘플/i.test(text) },
    { id: "production.filtering", domain: "production",
      match: (text, concept) => /filter/.test(concept) || /필터/i.test(text) },
    { id: "production.space", domain: "production",
      match: (text, concept) => /reverb|stereo|space/.test(concept) || /리버브|스테레오/i.test(text) }
  ]);

  function slug(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, "_").replace(/[^\w가-힣._-]/g, "").slice(0, 48) || "item";
  }

  function knownConcept(item) {
    const text = String(item.text || "");
    const concept = String(item.conceptId || item.concept || item.idiomId || item.id || "").toLowerCase();
    return KNOWN_CONCEPTS.find(entry => entry.match(text, concept)) || null;
  }

  function domainFor(item, axes) {
    if (item.domain) return item.domain;
    const known = knownConcept(item);
    if (known?.domain) return known.domain;
    const axis = (axes || [])[0];
    if (axis) {
      const family = Axes.familyOf(axis);
      if (DOMAIN_CAPS[family] != null) return family;
    }
    const category = item.category;
    if (category === "rhythm") return "rhythm";
    if (category === "production" || category === "dynamics") return "production";
    if (category === "arrangement" || category === "live") return "form";
    if (category === "instrumentation") return "instrumentation";
    if (category === "performance") return "performance";
    if (category === "genre") return "genre";
    if (["lineage", "era", "scene", "culture", "association", "mood"].includes(category)) return "context";
    return "other";
  }

  function conceptIdentity(item, axes) {
    if (item.conceptId) return { conceptId: item.conceptId, exclusiveGroup: item.exclusiveGroup || null };
    const known = knownConcept(item);
    if (known) return { conceptId: known.id, exclusiveGroup: known.group || null };
    if (item.concept && typeof item.concept === "string") {
      const domain = domainFor(item, axes);
      return { conceptId: `${domain}.${slug(item.concept)}`, exclusiveGroup: item.exclusiveGroup || null };
    }
    if (item.idiomId) return { conceptId: `idiom.${item.idiomId}`, exclusiveGroup: item.exclusiveGroup || null };
    const domain = domainFor(item, axes);
    return { conceptId: `${domain}.${slug(item.text)}`, exclusiveGroup: item.exclusiveGroup || null };
  }

  function salienceOf(item) {
    if (Number.isFinite(item.salience)) return clamp(item.salience);
    const axes = (item.evidenceAxes || []).length;
    return clamp((item.semanticConfidence || item.confidence || 0) * 0.55
      + Math.min(1, axes / 2) * 0.2
      + (item.temporal?.short || 0) * 0.25);
  }

  function persistenceOf(item) {
    if (Number.isFinite(item.persistence)) return item.persistence;
    return item.temporal?.stableForMs || 0;
  }

  function annotate(item, at) {
    const axes = Axes.independentAxes(item.anchors || []);
    const identity = conceptIdentity(item, axes);
    const domain = domainFor({ ...item, ...identity }, axes);
    return {
      ...item,
      conceptId: identity.conceptId,
      exclusiveGroup: identity.exclusiveGroup,
      domain,
      facet: item.facet || item.musicalFacet || identity.conceptId,
      evidenceAxes: axes,
      salience: salienceOf({ ...item, evidenceAxes: axes }),
      persistence: persistenceOf(item)
    };
  }

  function provenance(item, at, previous = null) {
    const confidence = clamp(item.confidence);
    const paths = (item.anchors || []).map(path => ({
      path, source: Axes.resolveEvidenceAxis(path), observedAt: at
    }));
    return {
      source: Array.isArray(item.source) ? item.source : [item.source || "semantic-pipeline"],
      path: paths.map(entry => entry.path),
      evidence: paths,
      firstSeenAt: previous?.firstSeenAt ?? at,
      lastSeenAt: at,
      currentConfidence: confidence,
      peakConfidence: Math.max(previous?.peakConfidence || 0, confidence)
    };
  }

  function evidenceStatus(item) {
    if (item.evidenceStatus === "contradicted" || item.contradicted === true) return "contradicted";
    if (item.evidenceStatus === "unknown" || item.supported === false) return "unknown";
    return "supported";
  }

  class Engine {
    constructor({ fastMs = 200, musicalMs = 5000, contextMs = 30000, switchMargin = 0.06,
      liveTtlMs = 1800, traitMinimumMs = 1500, cooldownMs = 800, domainCaps = null } = {}) {
      Object.assign(this, { fastMs, musicalMs, contextMs, switchMargin, liveTtlMs, traitMinimumMs, cooldownMs });
      this.domainCaps = { ...DOMAIN_CAPS, ...(domainCaps || {}) };
      this.reset();
    }

    reset() {
      this.history = new Map();
      this.stableByConcept = new Map();
      this.pendingByGroup = new Map();
      this.cooldownUntil = new Map();
      this.liveEvents = new Map();
      this.trackTraits = new Map();
      this.deepListeningMemory = new Map();
      this.historicalEvents = [];
      this.startedAt = 0;
      this.revision = 0;
      this.lastDebug = emptyDebug();
      // Back-compat aliases: older call sites read these names.
      this.stableByFacet = this.stableByConcept;
      this.pendingByFacet = this.pendingByGroup;
    }

    debugSnapshot() {
      return this.lastDebug;
    }

    update(rawCandidates = [], at = Date.now()) {
      if (this.startedAt === 0 && this.revision === 0) this.startedAt = at;
      const suppressed = [];
      const candidates = rawCandidates.map(item => Layers.decorate(item));
      const presentKeys = new Set();
      const presentConcepts = new Set();
      const evaluated = [];
      const stableBefore = this.stableByConcept.size;

      for (const raw of candidates) {
        const axes = Axes.independentAxes(raw.anchors || []);
        const identity = conceptIdentity(raw, axes);
        const item = { ...raw, conceptId: identity.conceptId, exclusiveGroup: identity.exclusiveGroup };
        const layer = Layers.layerFor(item.category, item);
        const status = evidenceStatus(item);
        const historyKey = identity.conceptId;
        const previousHistory = this.history.get(historyKey);
        const itemProvenance = provenance(item, at, previousHistory?.provenance);
        if (status !== "supported") {
          suppressed.push({ ...item, evidenceStatus: status, suppressionReason:
            status === "contradicted" ? "current-evidence-contradicts-claim" : "supporting-detector-unavailable",
            provenance: itemProvenance });
          continue;
        }
        presentKeys.add(keyFor(item));
        presentConcepts.add(identity.conceptId);
        const obsId = item.observationId || (Array.isArray(item.source) ? (item.source.includes("directAudio") ? item.claimId || "directAudio-event" : null) : item.source === "directAudio" ? item.claimId || "directAudio-event" : null);
        const isEventBased = Boolean(obsId);

        let observations = 1;
        const memoryEntry = isEventBased ? this.deepListeningMemory.get(historyKey) : null;
        const priorHistory = previousHistory || (memoryEntry ? {
          observations: memoryEntry.observations,
          firstSeenAt: memoryEntry.firstSeenAt,
          lastSeenAt: memoryEntry.lastSeenAt,
          lastObservationId: memoryEntry.lastObservationId,
          seenObservationIds: memoryEntry.seenObservationIds
        } : null);

        const seenObservationIds = priorHistory?.seenObservationIds instanceof Set
          ? new Set(priorHistory.seenObservationIds)
          : new Set(priorHistory?.lastObservationId ? [priorHistory.lastObservationId] : []);

        const memoryWindow = isEventBased ? 90000 : this.contextMs;
        if (priorHistory && at - priorHistory.lastSeenAt <= memoryWindow) {
          if (isEventBased) {
            if (obsId && seenObservationIds.has(obsId)) {
              observations = priorHistory.observations;
            } else {
              if (obsId) {
                seenObservationIds.add(obsId);
                if (seenObservationIds.size > 128) {
                  const first = seenObservationIds.values().next().value;
                  seenObservationIds.delete(first);
                }
              }
              observations = priorHistory.observations + 1;
            }
          } else {
            observations = priorHistory.observations + 1;
          }
        } else if (isEventBased && obsId) {
          seenObservationIds.add(obsId);
        }

        const history = {
          firstSeenAt: observations > 1 || (priorHistory && isEventBased) ? priorHistory.firstSeenAt : at,
          lastSeenAt: at,
          observations,
          lastObservationId: obsId || priorHistory?.lastObservationId || null,
          seenObservationIds,
          peakConfidence: Math.max(priorHistory?.peakConfidence || 0, clamp(item.confidence)),
          provenance: itemProvenance
        };
        history.provenance.firstSeenAt = history.firstSeenAt;
        history.provenance.peakConfidence = history.peakConfidence;
        this.history.set(historyKey, history);
        this.history.set(keyFor(item), history);
        if (isEventBased) {
          this.deepListeningMemory.set(historyKey, {
            key: historyKey,
            text: item.text,
            category: item.category,
            firstSeenAt: history.firstSeenAt,
            lastSeenAt: at,
            observations,
            lastObservationId: obsId,
            seenObservationIds,
            confidence: clamp(item.confidence)
          });
        }
        const stableForMs = at - history.firstSeenAt;
        const temporalStability = clamp(Math.min(1, observations / (layer === "LIVE" ? 1 : 6)) * 0.55 +
          Math.min(1, stableForMs / (layer === "FACT" ? this.musicalMs : this.contextMs)) * 0.45);
        const evaluatedItem = annotate({
          ...item, layer, semanticDistance: Layers.distances[layer],
          confidence: clamp(item.confidence), semanticConfidence: clamp(item.semanticConfidence ?? item.confidence),
          temporalStability, evidenceStatus: "supported", provenance: history.provenance, temporal: {
            current: clamp(item.confidence), short: temporalStability, long: temporalStability,
            observations, stableForMs, resolution: layer === "LIVE" ? "fast" : layer === "FACT" ? "musical" : "context"
          }
        }, at);
        evaluated.push(evaluatedItem);
        if (layer === "LIVE") {
          const ttlMs = Math.max(250, Number(item.ttlMs) || this.liveTtlMs);
          this.liveEvents.set(historyKey, {
            ...evaluatedItem, temporalScope: "TRANSIENT", ttlMs, expiresAt: at + ttlMs
          });
        }
      }

      for (const [key, item] of this.liveEvents) {
        if (at <= item.expiresAt) continue;
        this.liveEvents.delete(key);
        this.historicalEvents.push({ ...item, evidenceStatus: "expired", expiredAt: at });
      }
      this.historicalEvents = this.historicalEvents.slice(-64);

      const evicted = [];
      const exclusiveSwitches = [];
      const incoming = evaluated.filter(item => item.layer !== "LIVE");
      const byConcept = new Map();
      for (const item of incoming) {
        const previous = byConcept.get(item.conceptId);
        if (!previous || item.semanticConfidence > previous.semanticConfidence) byConcept.set(item.conceptId, item);
      }

      const exclusiveChallengers = new Map();
      for (const item of byConcept.values()) {
        if (!item.exclusiveGroup) continue;
        const list = exclusiveChallengers.get(item.exclusiveGroup) || [];
        list.push(item);
        exclusiveChallengers.set(item.exclusiveGroup, list);
      }
      for (const [group, list] of exclusiveChallengers) {
        list.sort((a, b) => b.semanticConfidence - a.semanticConfidence);
        const challenger = list[0];
        const current = [...this.stableByConcept.values()].find(item => item.exclusiveGroup === group);
        applyEligibility(this, challenger, current, at, exclusiveSwitches);
      }

      for (const item of byConcept.values()) {
        if (item.exclusiveGroup) continue;
        if ((this.cooldownUntil.get(item.conceptId) || 0) > at) continue;
        if (!isEligible(this, item)) continue;
        const current = this.stableByConcept.get(item.conceptId);
        this.stableByConcept.set(item.conceptId, { ...item, temporalScope: current?.temporalScope || "LOCAL_STATE" });
      }

      for (const [conceptId, item] of this.stableByConcept) {
        const history = this.history.get(conceptId);
        const ttl = item.layer === "FACT" ? this.musicalMs : this.contextMs;
        if (!history || at - history.lastSeenAt > ttl) {
          this.stableByConcept.delete(conceptId);
          evicted.push({ conceptId, reason: "stale-decay", text: item.text });
          this.cooldownUntil.set(conceptId, at + this.cooldownMs);
        }
      }

      evicted.push(...enforceDomainCaps(this, at));

      for (const item of incoming.filter(entry => entry.category !== "genre")) {
        const axes = item.evidenceAxes || [];
        const contextLike = ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(item.layer);
        const minimumMs = contextLike ? 5500 : this.traitMinimumMs;
        const strongMultiAxis = axes.length >= 2 && item.semanticConfidence >= 0.68;
        const exceptionalRepeated = item.temporal.observations >= 4 && item.semanticConfidence >= 0.78;
        if (item.temporal.observations >= 3 && item.temporal.stableForMs >= minimumMs && (strongMultiAxis || exceptionalRepeated)) {
          const previous = this.trackTraits.get(item.conceptId);
          this.trackTraits.set(item.conceptId, {
            ...item, temporalScope: "TRACK_TRAIT",
            promotedAt: previous?.promotedAt || at,
            lastConfirmedAt: at, evidenceStatus: "supported",
            promotionReason: strongMultiAxis ? "multi-axis" : "exceptional-repeated"
          });
        }
      }
      for (const [key, item] of this.trackTraits) {
        const history = this.history.get(key);
        const age = at - (history?.lastSeenAt ?? item.lastConfirmedAt);
        if (presentConcepts.has(key) || presentKeys.has(keyFor(item))) continue;
        if (age > this.contextMs) this.trackTraits.delete(key);
        else this.trackTraits.set(key, { ...item, evidenceStatus: "stale", currentConfidence: 0,
          provenance: { ...item.provenance, currentConfidence: 0 } });
      }

      for (const [key, item] of this.history) if (at - item.lastSeenAt > this.contextMs * 2) this.history.delete(key);
      for (const [key, until] of this.cooldownUntil) if (until <= at) this.cooldownUntil.delete(key);
      this.revision += 1;
      const liveEvents = [...this.liveEvents.values()];
      const shortTermStates = [...this.stableByConcept.values()].filter(item =>
        item.category !== "genre" && !this.trackTraits.has(item.conceptId));
      const genreHypotheses = [...this.stableByConcept.values()].filter(item => item.category === "genre");
      const trackTraits = [...this.trackTraits.values()];
      const stable = [...this.stableByConcept.values()];
      const visibleTraits = trackTraits.filter(item => item.evidenceStatus === "supported");
      const visibleStable = stable.filter(item => item.layer !== "FACT" || presentConcepts.has(item.conceptId)
        || presentKeys.has(keyFor(item)));
      const activeDirectAudio = evaluated.filter(item =>
        (item.sourceFamily === "directAudio" || item.source === "directAudio" || item.resolutionMomentum === true) &&
        (item.confidence ?? 0.6) >= 0.45
      );
      const displayCandidates = [...liveEvents, ...activeDirectAudio, ...visibleStable, ...visibleTraits].filter((item, index, all) =>
        all.findIndex(other => other.conceptId === item.conceptId || keyFor(other) === keyFor(item)) === index);

      const byDomain = {};
      for (const item of stable) byDomain[item.domain] = (byDomain[item.domain] || 0) + 1;
      this.lastDebug = {
        incoming: rawCandidates.length,
        evaluated: evaluated.length,
        stableBefore,
        stableAfter: this.stableByConcept.size,
        displayCandidates: displayCandidates.length,
        byDomain,
        evicted,
        exclusiveSwitches,
        traitCount: trackTraits.length,
        liveCount: liveEvents.length
      };
      this.stableByFacet = this.stableByConcept;
      this.pendingByFacet = this.pendingByGroup;

      return {
        windows: { fastMs: this.fastMs, musicalMs: this.musicalMs, contextMs: this.contextMs },
        elapsedMs: at - this.startedAt, revision: this.revision, evaluated, liveEvents, shortTermStates,
        trackTraits, genreHypotheses, historicalEvents: this.historicalEvents.slice(),
        contradictions: suppressed.filter(item => item.evidenceStatus === "contradicted"),
        stale: trackTraits.filter(item => item.evidenceStatus === "stale"), suppressed,
        stable, trackMemory: trackTraits, displayCandidates, debug: this.lastDebug, updatedAt: at
      };
    }
  }

  function emptyDebug() {
    return { incoming: 0, evaluated: 0, stableBefore: 0, stableAfter: 0, displayCandidates: 0,
      byDomain: {}, evicted: [], exclusiveSwitches: [], traitCount: 0, liveCount: 0 };
  }

  function isEligible(engine, item) {
    const isDirectAudio = item.sourceFamily === "directAudio" || item.source === "directAudio" || item.resolutionMomentum === true;
    const minimum = isDirectAudio ? 0.48 : ({ FACT: 0.58, CONTEXT: 0.66, AESTHETIC: 0.62, IMPRESSION: 0.56 }[item.layer] ?? 0.58);
    const neededObservations = isDirectAudio ? 1 : (item.layer === "FACT" ? 2 : 3);
    const neededMs = isDirectAudio ? 0 : (["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(item.layer) ? 5500 : 0);
    return item.semanticConfidence >= minimum && item.temporal.observations >= neededObservations
      && item.temporal.stableForMs >= neededMs;
  }

  function applyEligibility(engine, challenger, current, at, exclusiveSwitches) {
    if ((engine.cooldownUntil.get(challenger.conceptId) || 0) > at) return;
    const eligible = isEligible(engine, challenger);
    if (!current && eligible) {
      engine.stableByConcept.set(challenger.conceptId, { ...challenger, temporalScope: "LOCAL_STATE" });
      return;
    }
    if (current && current.conceptId === challenger.conceptId) {
      engine.stableByConcept.set(challenger.conceptId, { ...challenger, temporalScope: current.temporalScope || "LOCAL_STATE" });
      return;
    }
    if (current && eligible && challenger.semanticConfidence >= (current.semanticConfidence || current.confidence) + engine.switchMargin) {
      const pending = engine.pendingByGroup.get(challenger.exclusiveGroup);
      const delay = ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(challenger.layer) ? 2500 : 800;
      if (pending?.key === challenger.conceptId && at - pending.since >= delay) {
        engine.stableByConcept.delete(current.conceptId);
        engine.stableByConcept.set(challenger.conceptId, { ...challenger, temporalScope: "LOCAL_STATE" });
        engine.pendingByGroup.delete(challenger.exclusiveGroup);
        engine.cooldownUntil.set(current.conceptId, at + engine.cooldownMs);
        exclusiveSwitches.push({ group: challenger.exclusiveGroup, from: current.conceptId, to: challenger.conceptId });
      } else if (!pending || pending.key !== challenger.conceptId) {
        engine.pendingByGroup.set(challenger.exclusiveGroup, { key: challenger.conceptId, since: at });
      }
    }
  }

  function enforceDomainCaps(engine, at) {
    const evicted = [];
    const grouped = new Map();
    for (const item of engine.stableByConcept.values()) {
      const list = grouped.get(item.domain) || [];
      list.push(item);
      grouped.set(item.domain, list);
    }
    for (const [domain, list] of grouped) {
      const cap = engine.domainCaps[domain] ?? engine.domainCaps.other;
      if (list.length <= cap) continue;
      list.sort((a, b) => (salienceOf(a) * (1 + persistenceOf(a) / 8000)) - (salienceOf(b) * (1 + persistenceOf(b) / 8000)));
      const overflow = list.slice(0, list.length - cap);
      for (const item of overflow) {
        engine.stableByConcept.delete(item.conceptId);
        engine.cooldownUntil.set(item.conceptId, at + engine.cooldownMs);
        evicted.push({ conceptId: item.conceptId, reason: "domain-cap", domain, text: item.text });
      }
    }
    return evicted;
  }

  return {
    Engine, FAST, MUSICAL, CONTEXT, provenance, evidenceStatus, keyFor, rootsFor,
    resolveEvidenceAxis: Axes.resolveEvidenceAxis, independentAxes: Axes.independentAxes,
    conceptIdentity, DOMAIN_CAPS
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TemporalEvidence;
