// Long-lived, per-song language fingerprint. Semantic epochs describe sections; they do not
// clear this profile. A new capture/file session (or an explicit high-confidence song change)
// does, preventing the previous track's concepts and exhaustion state from leaking forward.
const SongLanguageProfile = (() => {
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const compact = value => JSON.parse(JSON.stringify(value ?? null));

  class Profile {
    constructor() { this.reset(0); }

    reset(sessionId = this.sessionId || 0, reason = "session-reset") {
      this.sessionId = sessionId;
      this.songRevision = (this.songRevision || 0) + 1;
      this.startedAt = Date.now();
      this.resetReason = reason;
      this.usage = new Map();
      this.recentConcepts = [];
      this.lastState = null;
      this.lastCandidates = [];
    }

    observe(state = {}, reservoir = [], { sessionId = this.sessionId, at = Date.now() } = {}) {
      if (sessionId !== this.sessionId) this.reset(sessionId);
      // Microphone mode can change songs without creating a file session. Only an explicit or
      // exceptionally strong, corroborated signal resets the song memory; ordinary section epochs
      // must not. This keeps the conservative genre-stability behavior intact.
      const oldGenre = this.lastState?.primaryGenre;
      const newGenre = state.genre?.uncertain ? null : state.genre?.primary;
      const strongSongChange = state.songChangeDetected === true || Boolean(oldGenre && newGenre && oldGenre !== newGenre &&
        (state.genre?.confidence || 0) >= 0.82 && (state.semanticChange?.score || 0) >= 0.9 &&
        (state.novelty?.score || 0) >= 0.85 && (state.expressionFeatures?.observationSeconds || 0) >= 20);
      if (strongSongChange) this.reset(sessionId, "semantic-song-change");
      this.lastCandidates = reservoir.slice();
      this.lastState = {
        primaryGenre: newGenre,
        genreEvidence: compact((state.genre?.topK || state.genreEvidence || []).slice(0, 6)),
        productionSignature: compact(state.primitives?.production || state.trackCharacter?.production || {}),
        rhythmicSignature: compact(state.primitives?.pulse || state.trackCharacter?.rhythm || {}),
        harmonicSignature: compact(state.primitives?.harmony || state.harmonicMotion || state.trackCharacter?.harmony || {}),
        instrumentationSignature: compact((state.instrumentation?.observed || state.instruments || []).slice(0, 8)),
        aestheticSignature: compact((state.aestheticConceptCandidates || state.impressionConcepts || []).slice(0, 8)),
        primitiveStrengths: this.primitiveStrengths(state.primitives), observedAt: at
      };
      return this.snapshot(reservoir, at);
    }

    primitiveStrengths(primitives = {}) {
      const values = [];
      for (const [group, fields] of Object.entries(primitives || {})) {
        if (group === "meta" || !fields || typeof fields !== "object" || Array.isArray(fields)) continue;
        for (const [field, value] of Object.entries(fields)) {
          if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) >= 0.55)
            values.push({ path: `${group}.${field}`, value: Number(value.toFixed(3)) });
          else if (typeof value === "string" && !["unknown", "none"].includes(value))
            values.push({ path: `${group}.${field}`, value });
        }
      }
      return values.slice(0, 32);
    }

    noteUsed(candidate, at = Date.now()) {
      if (!candidate) return;
      const key = Quality.conceptKey(candidate);
      const previous = this.usage.get(key) || { count: 0, facet: Quality.musicalFacet(candidate), lastDisplayed: null, exhaustedUntil: 0 };
      const count = previous.count + 1;
      const threshold = ["GENRE", "INSTRUMENT", "AESTHETIC"].includes(previous.facet) ? 4 : 3;
      const cooldownMs = candidate.layer === "LIVE" ? 12000 : candidate.layer === "FACT" ? 26000 : 42000;
      const exhaustedUntil = count >= threshold ? at + cooldownMs : previous.exhaustedUntil;
      this.usage.set(key, { ...previous, count, lastDisplayed: at, exhaustedUntil });
      this.recentConcepts = [...this.recentConcepts.filter(value => value !== key), key].slice(-32);
    }

    annotate(candidates = [], at = Date.now()) {
      const facetUsage = {};
      for (const value of this.usage.values()) facetUsage[value.facet] = (facetUsage[value.facet] || 0) + value.count;
      const availableFacets = [...new Set(candidates.map(item => Quality.musicalFacet(item)))];
      const minUse = availableFacets.length ? Math.min(...availableFacets.map(facet => facetUsage[facet] || 0)) : 0;
      return candidates.map(candidate => {
        const conceptKey = Quality.conceptKey(candidate);
        const musicalFacet = Quality.musicalFacet(candidate);
        const used = this.usage.get(conceptKey) || { count: 0, lastDisplayed: null, exhaustedUntil: 0 };
        const facetCount = facetUsage[musicalFacet] || 0;
        const facetNeed = clamp(1 / (1 + Math.max(0, facetCount - minUse) * 0.45));
        return { ...candidate, conceptKey, musicalFacet, songUsageCount: used.count,
          recentUsage: this.recentConcepts.includes(conceptKey), lastDisplayed: used.lastDisplayed,
          exhaustedUntil: used.exhaustedUntil, exhausted: used.exhaustedUntil > at,
          unexplored: used.count === 0, facetNeed };
      });
    }

    snapshot(reservoir = this.lastCandidates, at = Date.now()) {
      const annotated = this.annotate(reservoir, at);
      const byFacet = {};
      for (const item of annotated) {
        const list = byFacet[item.musicalFacet] || (byFacet[item.musicalFacet] = []);
        list.push(item);
      }
      const dominantFacets = Object.entries(byFacet).map(([facet, items]) => ({ facet,
        strength: clamp(items.reduce((sum, item) => sum + (item.reservoirScore || item.confidence || 0), 0) / Math.max(1, items.length)),
        candidates: items.length })).sort((a, b) => b.strength - a.strength).slice(0, 8);
      const dominantConcepts = annotated.slice().sort((a, b) =>
        (b.reservoirScore || b.confidence || 0) - (a.reservoirScore || a.confidence || 0)).slice(0, 16)
        .map(item => ({ conceptKey: item.conceptKey, text: item.text, facet: item.musicalFacet,
          confidence: item.confidence, source: item.source }));
      return {
        sessionId: this.sessionId, songRevision: this.songRevision, startedAt: this.startedAt,
        resetReason: this.resetReason, dominantFacets, dominantConcepts,
        primitiveStrengths: this.lastState?.primitiveStrengths || [],
        genreEvidence: this.lastState?.genreEvidence || [],
        productionSignature: this.lastState?.productionSignature || {},
        rhythmicSignature: this.lastState?.rhythmicSignature || {},
        harmonicSignature: this.lastState?.harmonicSignature || {},
        instrumentationSignature: this.lastState?.instrumentationSignature || [],
        aestheticSignature: this.lastState?.aestheticSignature || [],
        recentConcepts: this.recentConcepts.slice(-24),
        exhaustedConcepts: annotated.filter(item => item.exhausted).map(item => item.conceptKey).slice(0, 24),
        unexploredConcepts: annotated.filter(item => item.unexplored).map(item => item.conceptKey).slice(0, 32),
        underrepresentedFacets: dominantFacets.slice().sort((a, b) =>
          (this.facetUse(a.facet) - this.facetUse(b.facet)) || b.strength - a.strength).slice(0, 6).map(item => item.facet)
      };
    }

    facetUse(facet) {
      let count = 0;
      for (const value of this.usage.values()) if (value.facet === facet) count += value.count;
      return count;
    }
  }

  return { Profile };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SongLanguageProfile;
