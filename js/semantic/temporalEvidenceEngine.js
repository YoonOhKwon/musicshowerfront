const TemporalEvidence = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const FAST = new Set(["live", "dynamics"]);
  const MUSICAL = new Set(["rhythm", "instrumentation", "performance", "arrangement", "production"]);
  const CONTEXT = new Set(["genre", "lineage", "mood", "era", "scene", "culture", "association"]);
  const keyFor = item => `${item.category}:${String(item.text).toLowerCase()}`;
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  class Engine {
    constructor({ fastMs = 200, musicalMs = 5000, contextMs = 30000, switchMargin = 0.06 } = {}) {
      Object.assign(this, { fastMs, musicalMs, contextMs, switchMargin }); this.reset();
    }
    reset() {
      this.history = new Map(); this.stableByFacet = new Map(); this.pendingByFacet = new Map();
      this.trackMemory = new Map(); this.startedAt = 0; this.revision = 0;
    }
    update(candidates = [], at = Date.now(), priors = {}) {
      if (this.startedAt === 0 && this.revision === 0) this.startedAt = at;
      const present = new Map();
      candidates = candidates.map(item => Layers.decorate(item));
      for (const item of candidates) {
        const key = keyFor(item), score = clamp(item.confidence);
        present.set(key, Math.max(present.get(key) || 0, score));
        const history = (this.history.get(key) || []).filter(x => at - x.at <= this.contextMs);
        history.push({ at, score }); this.history.set(key, history);
      }
      const evaluated = candidates.map(item => {
        const key = keyFor(item), history = this.history.get(key) || [];
        const short = mean(history.filter(x => at - x.at <= this.musicalMs).map(x => x.score));
        const long = mean(history.map(x => x.score));
        const prior = clamp(priors[key] || 0);
        const values = [[present.get(key), 0.4], [short, 0.3], [long, 0.2], [prior || null, 0.1]].filter(([value]) => value !== null && value !== undefined);
        const confidence = clamp(values.reduce((sum, [value, weight]) => sum + value * weight, 0) /
          Math.max(0.001, values.reduce((sum, [, weight]) => sum + weight, 0)));
        const firstAt = history[0]?.at ?? at;
        const layer = Layers.layerFor(item.category, item);
        return { ...item, layer, semanticDistance: Layers.distances[layer], confidence, weight: confidence, temporal: {
          current: present.get(key), short: short || 0, long: long || 0, prior, observations: history.length,
          stableForMs: at - firstAt, resolution: layer === "LIVE" ? "fast" : layer === "FACT" ? "musical" : "context"
        }};
      });

      const byFacet = new Map();
      for (const item of evaluated) {
        const list = byFacet.get(item.category) || []; list.push(item); byFacet.set(item.category, list);
      }
      const reconfirmedFacets = new Set();
      for (const [facet, list] of byFacet) {
        list.sort((a, b) => b.confidence - a.confidence);
        const challenger = list[0], current = this.stableByFacet.get(facet);
        const layer = challenger.layer;
        const minimum = { LIVE: 0.5, FACT: 0.58, CONTEXT: 0.66, AESTHETIC: 0.62, IMPRESSION: 0.56 }[layer];
        const neededObservations = layer === "LIVE" ? 1 : layer === "FACT" ? 2 : 3;
        const neededMs = ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(layer) ? 5500 : 0;
        const eligible = challenger.confidence >= minimum && challenger.temporal.observations >= neededObservations &&
          challenger.temporal.stableForMs >= neededMs;
        if (!current && eligible) { this.stableByFacet.set(facet, challenger); reconfirmedFacets.add(facet); }
        else if (current && keyFor(current) === keyFor(challenger)) { this.stableByFacet.set(facet, challenger); reconfirmedFacets.add(facet); }
        else if (current && eligible && challenger.confidence >= current.confidence + this.switchMargin) {
          const pending = this.pendingByFacet.get(facet);
          if (pending?.key === keyFor(challenger) && at - pending.since >= (["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(layer) ? 2500 : 800)) {
            this.stableByFacet.set(facet, challenger); this.pendingByFacet.delete(facet); reconfirmedFacets.add(facet);
          } else if (!pending || pending.key !== keyFor(challenger)) this.pendingByFacet.set(facet, { key: keyFor(challenger), since: at });
        }
      }
      // Track memory only re-confirms when a facet's evidence actually reappeared this tick;
      // a merely-persisted (never-unseated) stableByFacet entry must not renew its own expiry forever.
      for (const [facet, item] of this.stableByFacet) {
        if (reconfirmedFacets.has(facet) && item.confidence >= 0.68) this.trackMemory.set(keyFor(item), { ...item, lastConfirmedAt: at });
      }
      for (const [key, item] of this.trackMemory) if (at - item.lastConfirmedAt > this.contextMs) this.trackMemory.delete(key);
      this.revision += 1;
      const fast = evaluated.filter(item => item.layer === "LIVE" && item.confidence >= 0.5);
      const stable = [...this.stableByFacet.values()];
      const displayCandidates = [...fast, ...stable].filter((item, index, all) =>
        all.findIndex(other => keyFor(other) === keyFor(item)) === index);
      return {
        windows: { fastMs: this.fastMs, musicalMs: this.musicalMs, contextMs: this.contextMs },
        elapsedMs: at - this.startedAt, revision: this.revision, evaluated, stable,
        displayCandidates, trackMemory: [...this.trackMemory.values()], updatedAt: at
      };
    }
  }
  return { Engine, FAST, MUSICAL, CONTEXT };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TemporalEvidence;
