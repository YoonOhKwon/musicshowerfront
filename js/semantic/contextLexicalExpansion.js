// One approved context relation, many realizations. Meaning stays fixed; wording follows evidence.
const ContextLexicalExpansion = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");

  function variants(candidate = {}, store = {}) {
    const name = String(candidate.text || "")
      .replace(/\s*(계열|계보|문법|인접성|연상|씬|문화|미학)$/g, "").trim();
    if (!name) return [candidate];
    const family = String(candidate.relationFamily || "").toUpperCase();
    const licensed = store.licensed || new Set();
    const forms = [];
    const push = (text, kind) => {
      if (text && Facets.safeText(text, candidate.category)) forms.push({ text, kind });
    };
    if (family === "PARENT" || family === "LINEAGE") {
      push(`${name} 계열`, "canonical");
      push(`${name} 계보`, "historical");
      push(`${name} 문법`, "critical");
      if (licensed.has("sidechain")) push(`${name}식 펌핑`, "production-linked");
      if (licensed.has("sample_based")) push(`${name}식 샘플 루프`, "production-linked");
      if (licensed.has("four_on_floor")) push(`${name}에서 이어진 플로어`, "rhythm-linked");
      if (licensed.has("swing") || licensed.has("broken_beat")) push(`${name}식 스윙 감각`, "rhythm-linked");
    } else if (family === "ADJACENCY") {
      push(`${name} 인접성`, "canonical");
      if (licensed.has("sample_based")) push(`${name}식 샘플 감각`, "production-linked");
    } else if (family === "SCENE") {
      push(`${name}`, "canonical");
      push(`${name} 씬`, "scene-linked");
    } else if (family === "CULTURE") {
      push(`${name}`, "canonical");
    } else {
      return [candidate];
    }
    const unique = [];
    const seen = new Set();
    for (const form of forms) {
      if (seen.has(form.text)) continue;
      seen.add(form.text);
      unique.push({
        ...candidate,
        text: form.text,
        lexicalFamily: form.kind,
        genome: `CONTEXT:${family}:${name}`,
        concept: `${family}:${name}`,
        claimsUsed: [...(candidate.claimsUsed || []), `context_${family}_${name}`]
      });
    }
    return unique.length ? unique : [candidate];
  }

  function expand(candidates = [], state = {}) {
    const store = state.verifiedClaims || {};
    const expanded = [];
    for (const candidate of candidates) expanded.push(...variants(candidate, store));
    // Keep the relation count conservative: at most three realizations per genome.
    const byGenome = new Map();
    for (const item of expanded) {
      const key = item.genome || item.text;
      const list = byGenome.get(key) || [];
      if (list.length < 3) list.push(item);
      byGenome.set(key, list);
    }
    return [...byGenome.values()].flat();
  }

  return { variants, expand };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ContextLexicalExpansion;
