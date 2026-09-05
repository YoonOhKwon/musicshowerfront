// specificity / novelty / contrastiveness computed from the phrase and the current musical state,
// instead of per-layer constants. These three scores decide what actually reaches the screen,
// so they must move when the music or the recent phrase history moves.
const PhraseQuality = (() => {
  const Compatibility = typeof EvidenceCompatibility !== "undefined" ? EvidenceCompatibility : require("./evidenceCompatibility");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  // Terms that fit almost any music: allowed, but they must not look distinctive.
  const GENERIC = [/^감성적$/, /^몽환적$/, /^강렬함?$/, /^아름다운/, /^신비로운?/, /^좋은 에너지$/,
    /^독특한/, /^분위기 ?있는$/, /^인상적$/, /^다채로운$/, /^에너지 넘치는$/, /^세련된$/];
  // Raw single-axis descriptors: useful internally, weak as display language.
  const PRIMITIVE = [/^(?:매우 )?(?:높은|낮은|강한|약한|밝은|어두운|따뜻한|차가운)\s?\S*$/,
    /^(?:밝음|어두움|따뜻함|차가움|무거움|가벼움|경쾌함|차분함|들뜸)$/,
    /^(?:높은|낮은)\s?(?:밀도|에너지|음압|긴장)$/, /^(?:강한|약한)\s?(?:저역|고역|중역)$/];
  // Empty AI-poetry nouns; meaningless without a real feature behind them.
  const ABSTRACT = /네온|별빛|유리빛|파동|잔광|입자|맥동|심장|꿈결|몽환의|안개|서정의/;

  const stem = text => String(text || "").toLowerCase()
    .replace(/(?:적인|스러운|스럽다|하는|한|의|을|를|이|가|은|는|들|感|감)$/g, "")
    .replace(/[\s·・,.]/g, "");

  // Concepts that mean nearly the same thing should not read as brand new language.
  const SYNONYMS = [
    ["향수", "노스탤지", "회고", "추억", "nostalg"],
    ["애상", "쓸쓸", "멜랑", "우수", "슬픔"],
    ["경쾌", "들뜬", "발랄", "상쾌"],
    ["몽환", "꿈결", "환상", "夢"],
    ["긴장", "조임", "불안"],
    ["질주", "돌진", "폭주"],
    ["낭만", "로맨"]
  ];
  const ALIASES = new Map([
    ["kawaii", "kawaii"], ["카와이", "kawaii"],
    ["futurefunk", "futurefunk"], ["퓨처펑크", "futurefunk"],
    ["citypop", "citypop"], ["시티팝", "citypop"],
    ["ukgarage", "ukgarage"], ["ukg", "ukgarage"], ["유케이개러지", "ukgarage"],
    ["nostalgia", "nostalgia"], ["nostalgic", "nostalgia"], ["노스탤지어", "nostalgia"],
    ["향수", "nostalgia"], ["회고", "nostalgia"],
    ["높은음압", "highloudness"], ["큰음압", "highloudness"], ["매우높은라우드니스", "highloudness"]
  ]);
  const SEMANTIC_FAMILIES = Object.freeze([
    ["nostalgia", /향수|노스탤|회고|추억|retro|레트로/i],
    ["bittersweet", /애상|멜랑|쓸쓸|우수|bittersweet/i],
    ["dreamlike", /몽환|꿈결|dream/i],
    ["neon-city", /네온|chrome|크롬|도시의 밤|야경/i],
    ["light-glass", /빛|잔광|유리|투명|반짝|glow|glass/i],
    ["warmth", /따뜻|온기|포근|warm/i],
    ["coldness", /차가|냉기|cold/i],
    ["space-reverb", /공간|잔향|리버브|공백|여백|부유|space|reverb/i],
    ["energy-drive", /질주|추진|에너지|폭주|drive|propulsion/i],
    ["density-pressure", /압력|압축|조밀|밀도|과밀/i],
    ["brightness", /밝|찬란|경쾌|brigh/i],
    ["darkness", /어두|암흑|dark/i],
    ["swing-shuffle", /스윙|셔플|swing|shuffle/i],
    ["broken-beat", /브레이크|브로큰|2-step|2-Step|엇갈린/i],
    ["sample-loop", /샘플|루프|sample|loop/i],
    ["bass-motion", /베이스|저역|bass/i],
    ["harmonic-motion", /화성|코드|조성|harmon|chord|tonal/i],
    ["melodic-motion", /선율|멜로디|모티프|melod|motif/i]
  ]);
  const literalKey = input => String(typeof input === "object" ? input?.text : input || "")
    .toLowerCase().replace(/\s+/g, " ").trim();
  function relationFamily(input = {}) {
    if (typeof input === "object" && input.relationFamily) return String(input.relationFamily).toUpperCase();
    const text = String(typeof input === "object" ? input.text : input || "");
    const category = typeof input === "object" ? input.category || input.facet : null;
    const kind = typeof input === "object" ? input.kind : null;
    if (kind === "artist") return "ARTIST";
    if (category === "genre") return "PRIMARY_GENRE";
    if (category === "era") return "ERA";
    if (category === "scene" || /(?:씬)(?:\s*(?:연상|연관))?$/.test(text)) return "SCENE";
    if (category === "culture" || /(?:문화)(?:\s*(?:연상|연관))?$/.test(text)) return "CULTURE";
    if (/인접성(?:\s*(?:연상|연관))?$/.test(text)) return "ADJACENCY";
    if (/미학(?:\s*(?:연상|연관))?$/.test(text)) return "AESTHETIC_ASSOCIATION";
    if (category === "lineage" || /(?:계열|계보|문법)(?:\s*(?:연상|연관))?$/.test(text)) return "LINEAGE";
    if (category === "association" && String(typeof input === "object" ? input.layer : "").toUpperCase() === "AESTHETIC")
      return "AESTHETIC_ASSOCIATION";
    return "NONE";
  }
  function semanticFamily(input = {}) {
    if (typeof input === "object" && input.semanticFamily) return String(input.semanticFamily).toLowerCase();
    const text = String(typeof input === "object" ? input.text : input || "");
    const found = SEMANTIC_FAMILIES.find(([, pattern]) => pattern.test(text));
    if (found) return found[0];
    const relation = relationFamily(input);
    if (relation !== "NONE") return `relation:${relation.toLowerCase()}`;
    return `concept:${normalizedCore(input)}`;
  }
  function normalizedCore(input) {
    const text = String(typeof input === "object" ? input.text : input || "").toLowerCase().trim();
    // Remove only display qualifiers. Their meaning remains in relationFamily(), so
    // "House 계열" and "House 문화" still have different identities.
    const withoutQualifier = text
      .replace(/\s+(?:연상|연관)$/u, "")
      .replace(/\s+(?:미학|감성|계열|계보|인접성|문법|씬|문화)$/u, "")
      .replace(/[\s·・_.-]/g, "");
    return ALIASES.get(withoutQualifier) || withoutQualifier;
  }
  function inferredLayer(input, family, core = "") {
    if (typeof input === "object" && input.layer) return String(input.layer).toUpperCase();
    if (family === "AESTHETIC_ASSOCIATION") return "AESTHETIC";
    if (["PRIMARY_GENRE", "PARENT", "LINEAGE", "ADJACENCY", "ERA", "SCENE", "CULTURE", "ARTIST",
      "SOURCE", "INFLUENCE", "RHYTHMIC_AFFINITY", "COMPOSITION"].includes(family)) return "CONTEXT";
    if (typeof input === "object" && (input.category || input.facet) === "mood") return "IMPRESSION";
    if (core === "nostalgia" || String(core).startsWith("syn:0")) return "IMPRESSION";
    if (core === "highloudness") return "FACT";
    return "UNSPECIFIED";
  }
  function conceptKey(input) {
    const text = String(typeof input === "object" ? input.text : input || "");
    const value = text.toLowerCase();
    const group = SYNONYMS.findIndex(list => list.some(word => value.includes(word)));
    const core = group >= 0 ? `syn:${group}` : normalizedCore(input);
    let family = relationFamily(input);
    if (family === "NONE" && ["futurefunk", "citypop", "ukgarage"].includes(core)) family = "PRIMARY_GENRE";
    if (family === "NONE" && core === "kawaii") family = "AESTHETIC_ASSOCIATION";
    const layer = inferredLayer(input, family, core);
    return `${core}|${family}|${layer}`;
  }
  function sameConcept(left, right) {
    const [leftCore, leftFamily, leftLayer] = conceptKey(left).split("|");
    const [rightCore, rightFamily, rightLayer] = conceptKey(right).split("|");
    if (leftCore !== rightCore) return false;
    if (leftFamily !== rightFamily && leftFamily !== "NONE" && rightFamily !== "NONE") return false;
    return leftLayer === rightLayer || leftLayer === "UNSPECIFIED" || rightLayer === "UNSPECIFIED";
  }

  // Display facets are finer than the storage categories. Harmony and melody used to be placed
  // in the broad `dynamics`/`performance` buckets and were therefore invisible to rotation even
  // though their primitive anchors were different. Resolve the musical viewpoint from evidence
  // first and fall back to the category only when no stronger signal exists.
  function musicalFacet(input = {}) {
    if (typeof input === "object" && input.musicalFacet) return String(input.musicalFacet).toUpperCase();
    const item = typeof input === "object" ? input : { text: input };
    const paths = [...(item.anchors || []), ...Object.values(item.evidence || {}).flat()].join(" ");
    const text = String(item.text || "");
    if (/primitives\.harmony|primitives\.tonal|(?:^|\.)harmony\.|화성|코드|조성|cadence|modal/i.test(paths + " " + text)) return "HARMONY";
    if (/primitives\.melody|pitchEvidence|선율|멜로디|모티프|ostinato|contour/i.test(paths + " " + text)) return "MELODY";
    if (/primitives\.bass|워킹 베이스|베이스 라인|bass motion/i.test(paths + " " + text)) return item.category === "instrumentation" ? "INSTRUMENT" : "PERFORMANCE";
    const byCategory = { rhythm: "RHYTHM", instrumentation: "INSTRUMENT", performance: "PERFORMANCE",
      arrangement: "ARRANGEMENT", production: "PRODUCTION", dynamics: "PRODUCTION", genre: "GENRE",
      lineage: "GENRE", era: "ERA", scene: "SCENE", culture: "SCENE", association: "AESTHETIC",
      mood: item.layer === "AESTHETIC" ? "AESTHETIC" : "MOOD", live: "ARRANGEMENT" };
    return byCategory[item.category || item.facet] || "IMPRESSION";
  }

  // Four coarse tiers make a high-resolution musical observation beat a generic adjective at the
  // same confidence. This is intentionally a local verdict; an LLM cannot award itself Tier 4.
  function specificityTier(input = {}) {
    const item = typeof input === "object" ? input : { text: input };
    const text = String(item.text || "");
    if (isGeneric(text) || /^(?:dreamy|emotional|energetic|atmospheric|dynamic|rhythmic|melodic|powerful|chill|dark|bright)$/i.test(text)) return 1;
    if (isPrimitive(text) || item.primitive) return 2;
    const exact = /워킹 베이스|2-?Step|사이드체인|컴핑|모달|반음계|오스티나토|four-on|브레이크비트|셔플|스윙|아르페지오|보컬 찹|솔로|하프타임|더블타임|폴리리듬|cadence|modal mixture|walking bass|comping/i;
    if (exact.test(text) || ["idiom", "fact-composition", "live-event"].includes(item.source)) return 4;
    if (relationFamily(item) !== "NONE") return 3;
    if (["rhythm", "instrument", "production", "arrangement", "aesthetic-induction", "local-grammar"].includes(item.source) ||
      ["RHYTHM", "HARMONY", "MELODY", "INSTRUMENT", "PERFORMANCE", "ARRANGEMENT", "PRODUCTION", "GENRE", "ERA", "SCENE", "AESTHETIC"].includes(musicalFacet(item))) return 3;
    return 2;
  }

  function isPrimitive(text) {
    const value = String(text || "").trim();
    return PRIMITIVE.some(pattern => pattern.test(value));
  }
  function isGeneric(text) {
    const value = String(text || "").trim();
    return GENERIC.some(pattern => pattern.test(value));
  }

  // How much of this phrase is actually anchored in the current music?
  // A phrase that compresses several independent, agreeing features is the most specific kind.
  function specificity(candidate = {}, snapshot = {}, evidence = null) {
    const text = String(candidate.text || "");
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const compatibility = evidence || Compatibility.assess(text, snapshot);
    let score = 0.5;
    if (isGeneric(text)) score -= 0.24;
    if (isPrimitive(text)) score -= 0.2;
    // Established terminology and named traditions discriminate strongly.
    if (/[A-Za-z]{3,}/.test(text)) score += 0.1;
    if (/계열|문법|씬|문화|미학|연상|인접성/.test(text)) score += 0.08;
    // Multi-feature synthesis bonus: two or more independent supported claims.
    const supported = (compatibility.details || []).filter(item => item.support >= 0.55);
    score += Math.min(0.26, supported.length * 0.13);
    if (compatibility.contradiction >= 0.4) score -= 0.16;
    // Bare abstractions with nothing measured behind them are not specific.
    if (ABSTRACT.test(text) && supported.length === 0) score -= 0.2;
    if (words >= 2 && words <= 5) score += 0.05;
    if (words > 6) score -= 0.08;
    return clamp(score);
  }

  // Novelty falls when a phrase repeats a concept the screen just showed, even if worded differently.
  function novelty(candidate = {}, recent = []) {
    const key = conceptKey(candidate.text);
    const own = stem(candidate.text);
    let penalty = 0;
    for (let index = 0; index < recent.length; index++) {
      const other = recent[index];
      const text = typeof other === "string" ? other : other?.text;
      if (!text) continue;
      const recency = 1 - Math.min(0.75, index / Math.max(8, recent.length));
      const otherStem = stem(text);
      if (otherStem === own) penalty += 0.55 * recency;
      else if (sameConcept(candidate, other)) penalty += 0.4 * recency;
      else if (otherStem.length > 2 && own.length > 2 &&
        (otherStem.includes(own) || own.includes(otherStem))) penalty += 0.22 * recency;
    }
    return clamp(1 - penalty);
  }

  // Does this phrase separate the current track from music in general?
  function contrastiveness(candidate = {}, snapshot = {}, evidence = null) {
    const text = String(candidate.text || "");
    const compatibility = evidence || Compatibility.assess(text, snapshot);
    const supported = (compatibility.details || []).filter(item => item.support >= 0.55).length;
    let score = 0.45;
    if (isGeneric(text)) score -= 0.25;
    if (isPrimitive(text)) score -= 0.18;
    // Named genres, scenes, traditions and artist references are inherently discriminative.
    if (/계열|문법|씬|문화|미학|연상|인접성|[A-Za-z]{3,}/.test(text)) score += 0.2;
    score += Math.min(0.24, supported * 0.12);
    if (compatibility.contradiction >= 0.4) score -= 0.2;
    return clamp(score);
  }

  // The model may propose its own scores; they are treated as one opinion, never as truth.
  function blend(proposed, local, weight = 0.3) {
    return Number.isFinite(proposed) ? clamp(clamp(proposed) * weight + local * (1 - weight)) : local;
  }

  return { specificity, novelty, contrastiveness, blend, literalKey, conceptKey, sameConcept, normalizedCore, relationFamily,
    musicalFacet, specificityTier,
    semanticFamily, stem, isPrimitive, isGeneric, GENERIC, PRIMITIVE, ALIASES, SEMANTIC_FAMILIES };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PhraseQuality;
