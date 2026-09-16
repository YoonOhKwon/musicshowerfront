// DirectAudioRealizer: Converts English Music Flamingo concepts into natural,
// expressive Korean concept families without dumping raw English text onto the screen.
//
// Works in both Node.js and browser environments. Provides:
// 1. Instant zero-latency dictionary & morphological pattern realization.
// 2. Family generation (2-4 surface variations per concept) for rotation.
// 3. Normalized concept key indexing and track-scoped caching.
// 4. Remote LLM expansion helper that bypasses regular language pool cooldown.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DirectAudioRealizer = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // FACT-only technical families. Subjective layers stay in the original English until the
  // external realizer returns; this dictionary must not author AESTHETIC/IMPRESSION/CONTEXT.
  const KNOWN_EXPRESSIONS = {
    "deep sub-bass": ["깊은 서브베이스", "저역대 중량감", "단단한 서브 우퍼"],
    "rolling 808 sub-bass": ["구르는 808 서브", "지속적인 808 베이스", "깊은 808 저음"],
    "chopped vocal samples": ["잘게 쪼갠 보컬 샘플", "보컬 찹 레이어", "반복되는 보컬 조각"],
    "syncopated breakbeat": ["싱코페이션 브레이크", "당김음 브레이크비트", "변칙적인 드럼 루프"],
    "fast breakbeat": ["빠른 브레이크비트", "경쾌한 브레이크", "질주하는 드럼 브레이크"],
    "reverberant synth pads": ["긴 잔향의 신스 패드", "공기감 있는 패드", "넓게 번지는 패드"],
    "filtered disco loops": ["필터링된 디스코 루프", "먹먹하게 걸린 디스코 샘플", "필터 스윕 루프"],
    "four-on-the-floor kick": ["4/4 정박 킥", "직선적인 4/4 비트", "일정한 클럽 킥"],
    "driving offbeat hi-hats": ["오프비트 하이햇", "질주감을 주는 엇박 햇", "경쾌한 16비트 햇"],
    "sidechain compression pumping": ["사이드체인 펌핑", "숨쉬듯 오르내리는 컴프레션", "주기적으로 눌리는 음압"],
    // Faithful surface families for recurring Music Flamingo sentence shapes. These are
    // translations of the supplied relation, not locally invented interpretations: every
    // subject, qualifier, metre and mix-position claim remains present in each variant.
    "steady 4/4 drum beat": ["안정적인 4/4 드럼 비트", "일정하게 이어지는 사분의 사박 드럼", "고른 4/4 드럼 박자"],
    "bright synth pads": ["밝은 음색의 신스 패드", "환한 신스 패드 레이어", "명료하게 들리는 신스 패드"],
    "female japanese vocals": ["일본어 여성 보컬", "여성 보컬의 일본어 가창", "일본어로 노래하는 여성 보컬"],
    "drums and synths in a balanced mix": ["드럼과 신스가 균형 잡힌 믹스", "드럼·신스의 고른 믹스 밸런스", "드럼과 신스가 균형을 이루는 배치"],
    "vocals sit centrally in the mix": ["믹스 중앙에 자리한 보컬", "중앙에 배치된 보컬", "믹스의 센터에 놓인 보컬"],
    "bright and airy": ["밝고 공기감 있는 인상", "환한 음색과 가벼운 공기감", "밝게 트인 질감"],
    "melodic and uplifting": ["선율적이고 고양감 있는 인상", "멜로디와 고양감이 함께하는 흐름", "선율이 살아 있는 상승감"]
  };

  // Word token mapping for compositional translation
  const ADJECTIVE_MAP = {
    atmospheric: "대기감 있는",
    nocturnal: "야간의",
    urban: "도시적인",
    melancholic: "애상적인",
    propulsive: "추진력 있는",
    euphoric: "황홀한",
    weightless: "무중력의",
    digital: "디지털",
    liquid: "유려한",
    vintage: "빈티지",
    analog: "아날로그",
    warm: "따뜻한",
    cold: "차가운",
    glossy: "매끈한",
    gritty: "거친",
    distorted: "왜곡된",
    clean: "정갈한",
    hypnotic: "최면적인",
    minimal: "미니멀한",
    dense: "밀도 높은",
    spacious: "여백 있는",
    dark: "어두운",
    bright: "밝은",
    fast: "빠른",
    syncopated: "당김음의",
    reverberant: "울림 깊은",
    deep: "깊은",
    bittersweet: "달콤씁쓸한",
    urgent: "긴박한",
    playful: "장난스런",
    lofi: "로파이",
    "lo-fi": "로파이",
    subtle: "섬세한",
    raw: "날것의",
    steady: "안정적인",
    airy: "공기감 있는",
    melodic: "선율적인",
    uplifting: "고양감 있는",
    balanced: "균형 잡힌",
    central: "중앙의",
    female: "여성",
    male: "남성",
    japanese: "일본어"
  };

  const ADJECTIVE_VARIANTS = {
    bright: ["밝은", "환한", "명료한"],
    steady: ["안정적인", "일정한", "고른"],
    balanced: ["균형 잡힌", "고르게 맞물린", "밸런스가 맞는"],
    spacious: ["여백 있는", "넓게 트인", "공간감 있는"],
    dark: ["어두운", "낮게 가라앉은", "짙은"],
    warm: ["따뜻한", "온기 있는", "포근한"],
    clean: ["정갈한", "깨끗한", "선명한"]
  };

  const NOUN_MAP = {
    atmosphere: "공기감",
    textures: "질감",
    texture: "질감",
    nostalgia: "노스탤지어",
    propulsion: "추진력",
    melancholy: "애상",
    solitude: "고독",
    tension: "긴장감",
    lineage: "계보",
    heritage: "유산",
    tradition: "전통",
    scene: "씬",
    influence: "영향",
    resonance: "잔향",
    bounce: "탄력",
    drift: "부유감",
    haze: "아지랑이",
    space: "공간감",
    warmth: "온기",
    pads: "패드",
    pad: "패드",
    bass: "베이스",
    sub: "서브",
    kick: "킥",
    drums: "드럼",
    breakbeat: "브레이크비트",
    rhythm: "리듬",
    groove: "그루브",
    chords: "코드",
    keys: "건반",
    synths: "신스",
    samples: "샘플",
    vocals: "보컬",
    reverb: "잔향",
    delay: "딜레이",
    loop: "루프",
    beat: "비트",
    mix: "믹스",
    drum: "드럼",
    synth: "신스",
    vocal: "보컬",
    melody: "멜로디",
    flow: "흐름"
  };

  const GRAMMAR_TOKENS = new Set(["a", "an", "the", "and", "or", "in", "on", "at", "of", "with", "to"]);

  function normalizeKey(str) {
    if (typeof str !== "string") return "";
    return str
      .toLowerCase()
      .replace(/[{}\[\]"':;,._\-\/\\]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Dictionary keys may contain notation punctuation ("4/4") or idiomatic hyphens
  // ("four-on-the-floor"). Index them through the same canonicalizer as incoming text so
  // exact families remain reachable without damaging their display spelling.
  const NORMALIZED_KNOWN_EXPRESSIONS = Object.fromEntries(
    Object.entries(KNOWN_EXPRESSIONS).map(([key, family]) => [normalizeKey(key), family])
  );

  function cleanPhrase(str) {
    if (typeof str !== "string") return "";
    let clean = str.replace(/[{}\[\]"':;,]/g, " ").replace(/^[\s.\-_/]+|[\s.\-_/]+$/g, "").replace(/\s+/g, " ").trim();
    clean = clean.replace(/^\d+(?:\.\d+)?\s*reasoning(?:hints)?\b\s*/i, "").trim();
    if (/^(?:audibleObservations|genreHypotheses|contextHypotheses|aestheticConcepts|impressions|uncertainties|reasoning|confidence|category|label|text)\b/i.test(clean)) {
      return "";
    }
    if (/\b(?:reasoning(?:hints)?|confidence)\b/i.test(clean)) return "";
    return clean;
  }

  // Surface syntax only, never evidence that this aesthetic fits the audio. An already
  // model-proposed compact name may be displayed without translating it into generic prose.
  // Requiring a stem avoids ordinary words such as "score" and the bare suffix "core".
  function isCoreAestheticName(text, category) {
    return ["association", "aesthetic"].includes(category) && typeof text === "string" &&
      /^(?:[a-z]{3,}(?:-core|core)|[가-힣]{2,}코어)$/i.test(text.trim());
  }

  // Composes natural Korean phrase variations from English tokens
  function composeKoreanFamily(normKey, category) {
    const tokens = normKey.split(" ").filter(Boolean);
    if (!tokens.length) return [];

    const adjs = [];
    const nouns = [];
    const literals = [];
    const unknown = [];

    for (const t of tokens) {
      if (ADJECTIVE_MAP[t]) {
        adjs.push({ source: t, text: ADJECTIVE_MAP[t] });
      } else if (NOUN_MAP[t]) {
        nouns.push(NOUN_MAP[t]);
      } else if (/^\d+(?:\/\d+)?$/.test(t)) {
        literals.push(t);
      } else if (!GRAMMAR_TOKENS.has(t)) {
        unknown.push(t);
      }
    }

    // A real noun is required, never substituted with a generic filler ("공기감"/"질감"/"정서")
    // when the actual noun goes unrecognized. "late-2010s digital production trends" losing
    // everything but "digital" into "디지털 질감" is a confident translation of a DIFFERENT,
    // blander idea -- worse than admitting this dictionary can't cover it and keeping the
    // original English (realize()'s final fallback) until the async LLM realization arrives.
    if (!nouns.length || unknown.length) {
      return [];
    }

    const nounPhrase = [...literals, ...nouns].join(" ");
    const adjectivePhrase = adjs.map(item => item.text).join(" ");

    const variations = [];
    if (adjectivePhrase) {
      variations.push(`${adjectivePhrase} ${nounPhrase}`);
      if (adjs.length === 1) {
        for (const alternative of ADJECTIVE_VARIANTS[adjs[0].source] || []) {
          variations.push(`${alternative} ${nounPhrase}`);
        }
      }
    } else {
      if (category === "context") {
        variations.push(`${nounPhrase} 계열`);
        variations.push(`${nounPhrase} 스타일`);
      } else {
        variations.push(nounPhrase);
      }
    }

    return [...new Set(variations.filter(v => v && v.length >= 2))];
  }

  class Realizer {
    constructor(options = {}) {
      this.cache = new Map(); // conceptKey -> [korean phrases]
      this.externallyRealized = new Set();
      this.cacheLimit = options.cacheLimit || 500;
    }

    clear() {
      this.cache.clear();
      this.externallyRealized.clear();
    }

    // Main synchronous realization method
    realize(rawText, category = "aesthetic") {
      const text = cleanPhrase(rawText);
      if (!text) return [];

      // If text already contains Korean, return it directly
      if (/[가-힣]/.test(text)) {
        return [text];
      }

      if (isCoreAestheticName(text, category)) return [text];

      const key = normalizeKey(text);
      if (this.cache.has(key) && (this.externallyRealized.has(key) ||
          !["aesthetic", "impression", "context", "genre", "microgenre"].includes(category))) {
        return this.cache.get(key);
      }

      // Exact, meaning-preserving translations are safe in every layer. They alter wording only;
      // the audio model remains the sole author of the concept itself.
      if (NORMALIZED_KNOWN_EXPRESSIONS[key]) {
        const family = [...NORMALIZED_KNOWN_EXPRESSIONS[key]];
        this._setCache(key, family);
        return family;
      }

      // Genre/context names and subjective language are model-owned. Until the asynchronous
      // external realizer returns, preserve the exact Flamingo concept instead of replacing it
      // with a developer-authored dictionary phrase or morphological mood/aesthetic template.
      if (["genre", "microgenre", "context", "aesthetic", "impression"].includes(category)) {
        return [text];
      }

      const composed = composeKoreanFamily(key, category);
      if (composed.length > 0) {
        this._setCache(key, composed);
        return composed;
      }

      // Fallback: nothing recognized well enough to compose a real Korean phrase. Do NOT stitch a
      // Korean grammatical suffix onto untranslated English (e.g. "energetic yet contemplative적
      // 감각", "a global internet-driven music culture 요소") -- that reads as broken hybrid
      // grammar, worse than plain English. Keep it in English as an honest interim; the async LLM
      // realization path (registerFamily(), triggered from js/main.js's /api/realize-direct-audio
      // call) replaces this with real Korean once it arrives.
      const simpleFallback = [text];
      this._setCache(key, simpleFallback);
      return simpleFallback;
    }

    // Register a known or remotely generated realization family
    registerFamily(conceptText, family = []) {
      const key = normalizeKey(conceptText);
      if (!key || !Array.isArray(family) || !family.length) return;
      const valid = family.filter(f => typeof f === "string" && f.trim() && /[가-힣]/.test(f));
      if (valid.length) {
        this.externallyRealized.add(key);
        this._setCache(key, valid);
      }
    }

    _setCache(key, family) {
      if (this.cache.size >= this.cacheLimit) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      this.cache.set(key, family);
    }
  }

  // Singleton instance
  const defaultRealizer = new Realizer();

  return {
    Realizer,
    defaultRealizer,
    realize: (text, category) => defaultRealizer.realize(text, category),
    registerFamily: (conceptText, family) => defaultRealizer.registerFamily(conceptText, family),
    realizeFact: (text) => defaultRealizer.realize(text, "fact"),
    realizeExternalConcept: (text, category) => defaultRealizer.realize(text, category),
    normalizeKey,
    cleanPhrase,
    isCoreAestheticName,
    KNOWN_EXPRESSIONS
  };
});
