// Scores local FACT/LIVE separately from CONTEXT/AESTHETIC. Not a quota filler:
// a weak domain is left empty rather than forced onto the screen.
const WordPoolScheduler = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const LOCAL = new Set(["LIVE", "FACT"]);
  const INTERPRETIVE = new Set(["CONTEXT", "AESTHETIC", "IMPRESSION"]);

  function domainOf(item = {}) {
    if (item.domain) return String(item.domain);
    const facet = String(item.facet || item.category || Quality.musicalFacet(item) || "other").toLowerCase();
    if (/rhythm|pulse|drum/.test(facet + (item.conceptId || ""))) return "rhythm";
    if (/bass/.test(facet + (item.conceptId || ""))) return "bass";
    if (/harmon|tonal|chord/.test(facet + (item.conceptId || "") + (item.text || ""))) return "harmony";
    if (/melody|선율|모티프/.test(facet + (item.conceptId || "") + (item.text || ""))) return "melody";
    if (/production|filter|reverb|sidechain|sample|stereo/.test(facet + (item.conceptId || "") + (item.text || "")))
      return "production";
    if (/performance|comping|walking/.test(facet + (item.conceptId || ""))) return "performance";
    if (/form|arrangement|layer/.test(facet + (item.conceptId || ""))) return "form";
    return facet || "other";
  }

  function freshnessOf(item, now, epoch) {
    if (Number.isFinite(item.freshness)) return clamp(item.freshness);
    if (item.layer === "LIVE") return 0.85;
    if (Number.isFinite(item.semanticEpoch) && Number.isFinite(epoch) && item.semanticEpoch === epoch) return 0.7;
    return 0.45;
  }

  function persistenceOf(item) {
    if (Number.isFinite(item.persistence)) return clamp(item.persistence / 12000);
    if (item.layer === "FACT") return 0.7;
    if (item.layer === "LIVE") return 0.25;
    return 0.5;
  }

  function shownCount(item, recent = []) {
    const key = item.conceptId || Quality.conceptKey(item);
    return recent.filter(previous => (previous.conceptId || Quality.conceptKey(previous)) === key).length;
  }

  function score(item, { recent = [], now = Date.now(), semanticEpoch = null, changing = false } = {}) {
    const decorated = Layers.decorate(item);
    const local = LOCAL.has(decorated.layer);
    const repeats = shownCount(decorated, recent.slice(-12));
    const recentHits = recent.slice(-8).filter(previous =>
      (previous.conceptId || Quality.conceptKey(previous)) === (decorated.conceptId || Quality.conceptKey(decorated))).length;
    const weakened = (decorated.confidence || 0) < 0.55;
    const confidence = decorated.confidence ?? decorated.evidenceScore ?? 0.55;
    const salience = decorated.salience ?? 0.55;
    const freshness = freshnessOf(decorated, now, semanticEpoch);
    const persistence = persistenceOf(decorated);
    const novelty = Quality.novelty ? Quality.novelty(decorated, recent) : 0.6;
    const temporal = Layers.temporalFitness(decorated, { changing, observationSeconds: Infinity }) || 0.6;
    const weights = local
      ? (decorated.layer === "LIVE"
        ? { confidence: 0.16, salience: 0.14, freshness: 0.28, persistence: 0.08, novelty: 0.14, temporal: 0.2 }
        : { confidence: 0.24, salience: 0.18, freshness: 0.12, persistence: 0.2, novelty: 0.12, temporal: 0.14 })
      : { confidence: 0.18, salience: 0.12, freshness: 0.1, persistence: 0.16, novelty: 0.22, temporal: 0.22 };
    let total = confidence * weights.confidence + salience * weights.salience + freshness * weights.freshness
      + persistence * weights.persistence + novelty * weights.novelty + temporal * weights.temporal;
    total *= 1 / (1 + repeats * 0.85);
    if (recentHits >= 3 && weakened) total *= 0.18;
    else if (recentHits >= 2) total *= 0.45;
    return Math.max(0.001, total);
  }

  function decorateCandidate(item, options = {}) {
    const decorated = Layers.decorate(item);
    const selectionScore = score(decorated, options);
    return {
      ...decorated,
      conceptId: decorated.conceptId || Quality.conceptKey(decorated),
      domain: domainOf(decorated),
      facet: decorated.facet || decorated.category,
      confidence: decorated.confidence ?? decorated.evidenceScore ?? 0.55,
      salience: decorated.salience ?? 0.55,
      persistence: decorated.persistence ?? persistenceOf(decorated),
      freshness: freshnessOf(decorated, options.now, options.semanticEpoch),
      source: decorated.source,
      semanticEpoch: decorated.semanticEpoch ?? decorated.epoch ?? options.semanticEpoch ?? null,
      selectionScore
    };
  }

  function preferLocal(items = []) {
    const local = items.filter(item => LOCAL.has(item.layer));
    return local.length >= 2 ? local : items;
  }

  function applyDomainDiversity(ranked, recent = []) {
    const recentDomains = recent.slice(-5).map(domainOf);
    const selected = [];
    for (const item of ranked) {
      const domain = domainOf(item);
      const sameRecent = recentDomains.filter(name => name === domain).length
        + selected.filter(other => domainOf(other) === domain).length;
      if (sameRecent >= 2 && ranked.some(other => domainOf(other) !== domain && other.selectionScore >= item.selectionScore * 0.72))
        continue;
      selected.push(item);
    }
    return selected.length ? selected : ranked.slice(0, 1);
  }

  function prepare(source = [], recent = [], options = {}) {
    const scored = source.map(item => decorateCandidate(item, { ...options, recent }));
    const localFirst = options.preferLocal ? preferLocal(scored) : scored;
    localFirst.sort((a, b) => b.selectionScore - a.selectionScore);
    const diversified = options.domainDiversity ? applyDomainDiversity(localFirst, recent) : localFirst;
    const decision = {
      at: options.now || Date.now(),
      semanticEpoch: options.semanticEpoch ?? null,
      considered: scored.length,
      localCount: scored.filter(item => LOCAL.has(item.layer)).length,
      interpretiveCount: scored.filter(item => INTERPRETIVE.has(item.layer)).length,
      ranked: diversified.slice(0, 8).map(item => ({
        text: item.text, conceptId: item.conceptId, layer: item.layer, domain: item.domain,
        selectionScore: Number(item.selectionScore.toFixed(3)),
        confidence: item.confidence, salience: item.salience,
        anchors: item.anchors || [], shownRecently: shownCount(item, recent)
      }))
    };
    lastDecision = decision;
    return { items: diversified, decision };
  }

  let lastDecision = { ranked: [], considered: 0 };

  function debugDecision() {
    return lastDecision;
  }

  return { score, decorateCandidate, prepare, domainOf, debugDecision, LOCAL, INTERPRETIVE };
})();

if (typeof module !== "undefined" && module.exports) module.exports = WordPoolScheduler;
