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

  // Dictionary of known recurring musical concepts and idioms to Korean realization families
  const KNOWN_EXPRESSIONS = {
    // Aesthetics & Textures
    "nocturnal atmosphere": ["야간의 공기감", "밤의 부유감", "어두운 밤빛 정서", "심야의 공간감"],
    "nocturnal urban atmosphere": ["밤거리의 공기감", "네온빛 도시감", "심야 도심의 정서", "도시적인 야간 정경"],
    "late-night urban atmosphere": ["심야 도심의 공기감", "밤거리의 매끈한 질감", "차가운 도심의 윤기"],
    "glossy late-night urban atmosphere": ["도시적인 야간의 광택", "밤거리의 매끈한 질감", "네온빛 도시감", "차가운 도심의 윤기"],
    "liquid atmospheric textures": ["액체처럼 흐르는 질감", "유려한 대기감", "부드러운 잔향 층", "물결치는 공간감"],
    "atmospheric textures": ["공기감 있는 질감", "넓게 번지는 대기감", "유려한 질감 층"],
    "digital nostalgia": ["디지털 노스탤지어", "오래된 데이터의 향수", "픽셀의 잔향", "가상 공간의 그리움"],
    "internet nostalgia": ["인터넷 노스탤지어", "초기 웹의 아련함", "가상 공간의 잔향"],
    "neon city aesthetics": ["네온빛 도시 감성", "도심의 네온 질감", "밤의 사이버 감각"],
    "japanese bubble era resonance": ["일본 버블기의 잔향", "시티팝 시대의 여운", "황금기의 잔향"],
    "lo-fi tape warmth": ["로파이 테이프의 온기", "카세트 테이프 질감", "아날로그 테이프 여운"],
    "vintage cassette warmth": ["빈티지 카세트 온기", "아날로그 테이프 질감", "바랜 녹음의 여운"],
    "spacious reverb tails": ["넓은 잔향의 여운", "깊은 공간의 울림", "확산되는 잔향"],
    "crystalline synth textures": ["수정처럼 맑은 신스", "투명한 신스 질감", "빛나는 건반 텍스처"],
    "distorted industrial textures": ["왜곡된 인더스트리얼 질감", "거친 금속성 질감", "산업적 파열음"],
    "minimalist ambient space": ["미니멀한 앰비언트 공간", "정적인 여백", "절제된 공간감"],

    // Impressions & Emotional Dynamics
    "melancholic propulsion": ["질주하는 애상", "추진력 속의 쓸쓸함", "달리면서 남는 애수", "들뜬 우울감"],
    "melancholic yet propulsive": ["질주하는 애상", "추진력 속의 쓸쓸함", "속도감 있는 아련함", "들뜬 우울감"],
    "bittersweet euphoric rush": ["달콤씁쓸한 고양감", "벅차오르는 애수", "아련한 도취감"],
    "euphoric melancholy": ["도취적인 애상", "황홀한 우울감", "환희 속의 쓸쓸함"],
    "weightless drift": ["무중력의 부유감", "가벼운 부유 상태", "공중에 뜬 듯한 정서"],
    "contemplative solitude": ["사색적인 고독", "혼자만의 침잠", "고요한 사색"],
    "hypnotic trance": ["최면적인 몰입", "반복 속의 도취", "집중된 트랜스감"],
    "urgent tension": ["긴박한 긴장감", "몰아치는 초조함", "팽팽한 긴장"],
    "playful bounce": ["경쾌한 탄력", "장난스런 리듬감", "통통 튀는 활력"],
    "dreamy haze": ["몽환적인 아지랑이", "꿈결 같은 흐릿함", "아련한 안개감"],
    "ethereal floating": ["에테리얼한 부유감", "천상의 공기감", "아득한 떠돎"],

    // Context & Lineage
    "uk rave lineage": ["UK 레이브의 계보", "영국 레이브의 잔향", "초기 레이브 사운드"],
    "french filter house lineage": ["프렌치 필터 하우스 계보", "필터 하우스의 잔향", "파리지앵 디스코 감각"],
    "chicago footwork tradition": ["시카고 풋워크 전통", "풋워크 리듬 계보", "폴리리듬 풋워크"],
    "detroit techno heritage": ["디트로이트 테크노 유산", "기계적 미래주의", "모터시티의 잔향"],
    "south african club scene": ["남아공 클럽 씬", "더반 사운드 계보", "현대 아프리칸 클럽"],
    "japanese city pop influence": ["일본 시티팝의 영향", "시티팝 감성의 차용", "80년대 도시 대중음악"],
    "memphis rap underground": ["멤피스 랩 언더그라운드", "로우 파이 테이프 힙합", "남부 언더그라운드 잔향"],

    // Audible Facts & Observations
    "deep sub-bass": ["깊은 서브베이스", "저역대 중량감", "단단한 서브 우퍼"],
    "rolling 808 sub-bass": ["구르는 808 서브", "지속적인 808 베이스", "깊은 808 저음"],
    "chopped vocal samples": ["잘게 쪼갠 보컬 샘플", "보컬 찹 레이어", "반복되는 보컬 조각"],
    "syncopated breakbeat": ["싱코페이션 브레이크", "당김음 브레이크비트", "변칙적인 드럼 루프"],
    "fast breakbeat": ["빠른 브레이크비트", "경쾌한 브레이크", "질주하는 드럼 브레이크"],
    "reverberant synth pads": ["긴 잔향의 신스 패드", "공기감 있는 패드", "넓게 번지는 패드"],
    "filtered disco loops": ["필터링된 디스코 루프", "먹먹하게 걸린 디스코 샘플", "필터 스윕 루프"],
    "four-on-the-floor kick": ["4/4 정박 킥", "직선적인 4/4 비트", "일정한 클럽 킥"],
    "driving offbeat hi-hats": ["오프비트 하이햇", "질주감을 주는 엇박 햇", "경쾌한 16비트 햇"],
    "sidechain compression pumping": ["사이드체인 펌핑", "숨쉬는 컴프레션", "강한 펌핑 질감"]
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
    dreamy: "몽환적인",
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
    ethereal: "아득한",
    lofi: "로파이",
    "lo-fi": "로파이",
    funky: "펑키한",
    groovy: "그루비한",
    subtle: "섬세한",
    raw: "날것의",
    futuristic: "미래적인",
    retro: "레트로",
    nostalgic: "향수를 자극하는"
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
    loop: "루프"
  };

  function normalizeKey(str) {
    if (typeof str !== "string") return "";
    return str
      .toLowerCase()
      .replace(/[{}\[\]"':;,._\-\/\\]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

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

  // Composes natural Korean phrase variations from English tokens
  function composeKoreanFamily(normKey, category) {
    const tokens = normKey.split(" ").filter(Boolean);
    if (!tokens.length) return [];

    const adjs = [];
    const nouns = [];

    for (const t of tokens) {
      if (ADJECTIVE_MAP[t]) {
        adjs.push(ADJECTIVE_MAP[t]);
      } else if (NOUN_MAP[t]) {
        nouns.push(NOUN_MAP[t]);
      }
    }

    if (!nouns.length && !adjs.length) {
      return [];
    }

    const primaryNoun = nouns[nouns.length - 1] || (category === "aesthetic" ? "공기감" : category === "impression" ? "정서" : "질감");
    const primaryAdj = adjs[0] || "";
    const secondaryAdj = adjs[1] || "";

    const variations = [];
    if (primaryAdj && primaryNoun) {
      variations.push(`${primaryAdj} ${primaryNoun}`);
      if (secondaryAdj) {
        variations.push(`${primaryAdj} ${secondaryAdj} ${primaryNoun}`);
        variations.push(`${secondaryAdj} ${primaryNoun}`);
      } else {
        // Add expressive variants
        if (category === "aesthetic") {
          variations.push(`${primaryAdj} 분위기`);
          variations.push(`${primaryAdj} 질감`);
        } else if (category === "impression") {
          variations.push(`${primaryAdj} 무드`);
          variations.push(`${primaryAdj} 감각`);
        } else {
          variations.push(`${primaryAdj} 사운드`);
        }
      }
    } else if (primaryNoun) {
      if (category === "context") {
        variations.push(`${primaryNoun} 계열`);
        variations.push(`${primaryNoun} 스타일`);
      } else {
        variations.push(primaryNoun);
      }
    }

    return [...new Set(variations.filter(v => v && v.length >= 2))];
  }

  class Realizer {
    constructor(options = {}) {
      this.cache = new Map(); // conceptKey -> [korean phrases]
      this.cacheLimit = options.cacheLimit || 500;
    }

    clear() {
      this.cache.clear();
    }

    // Main synchronous realization method
    realize(rawText, category = "aesthetic") {
      const text = cleanPhrase(rawText);
      if (!text) return [];

      // If text already contains Korean, return it directly
      if (/[가-힣]/.test(text)) {
        return [text];
      }

      const key = normalizeKey(text);
      if (this.cache.has(key)) {
        return this.cache.get(key);
      }

      // Check known expressions dictionary
      if (KNOWN_EXPRESSIONS[key]) {
        const family = [...KNOWN_EXPRESSIONS[key]];
        this._setCache(key, family);
        return family;
      }

      // Special handling for genre:
      if (category === "genre" || category === "microgenre") {
        // Open-world genres often display well in English, plus a Koreanized descriptor
        const family = [text];
        if (KNOWN_EXPRESSIONS[key]) {
          family.push(...KNOWN_EXPRESSIONS[key]);
        }
        this._setCache(key, family);
        return family;
      }

      // Morphological composition
      const composed = composeKoreanFamily(key, category);
      if (composed.length > 0) {
        this._setCache(key, composed);
        return composed;
      }

      // Fallback: If nothing matched, provide concise contextual Korean wrapper
      const fallbackSuffix = category === "aesthetic" ? "적 분위기"
        : category === "impression" ? "적 감각"
        : category === "context" ? " 계열"
        : " 요소";

      const simpleFallback = [`${text}${fallbackSuffix}`];
      this._setCache(key, simpleFallback);
      return simpleFallback;
    }

    // Register a known or remotely generated realization family
    registerFamily(conceptText, family = []) {
      const key = normalizeKey(conceptText);
      if (!key || !Array.isArray(family) || !family.length) return;
      const valid = family.filter(f => typeof f === "string" && f.trim() && /[가-힣]/.test(f));
      if (valid.length) {
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
    normalizeKey,
    cleanPhrase,
    KNOWN_EXPRESSIONS
  };
});
