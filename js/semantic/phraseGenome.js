// Phrase genome: text is a realization, the genome is the meaning.
// Repetition control and information-gain read the genome, not the surface string.
const PhraseGenome = (() => {
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");

  function key(candidate = {}) {
    if (candidate.genome) return String(candidate.genome);
    const claims = (candidate.claimsUsed || []).slice().sort().join("+");
    const concept = candidate.concept || Quality.conceptKey(candidate);
    const operator = candidate.operator || "ATOMIC";
    const layer = candidate.layer || "FACT";
    return claims ? `${layer}:${operator}:${claims}` : `${layer}:${operator}:${concept}`;
  }

  function decorate(candidate = {}) {
    const genome = key(candidate);
    return { ...candidate, genome, concept: candidate.concept || genome };
  }

  function informationGain(candidate = {}, recent = []) {
    const item = decorate(candidate);
    const sameGenome = recent.filter(previous => key(previous) === item.genome).length;
    const sameFamily = recent.filter(previous => Quality.semanticFamily(previous) === Quality.semanticFamily(item)).length;
    const sameClaims = (item.claimsUsed || []).length
      ? recent.filter(previous => (previous.claimsUsed || []).join() === (item.claimsUsed || []).join()).length
      : 0;
    const layer = item.layer || "FACT";
    const family = item.relationFamily || "";
    const cooldown = /CULTURE|SCENE|ARTIST/.test(family) ? 0.4
      : layer === "CONTEXT" ? 0.28
      : layer === "AESTHETIC" ? 0.18 : 0.12;
    return Math.max(0, 1 - sameGenome * 0.55 - sameFamily * cooldown - sameClaims * 0.22);
  }

  return { key, decorate, informationGain };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PhraseGenome;
