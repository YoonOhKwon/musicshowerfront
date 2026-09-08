// Same musical claim, several FACT/LIVE wordings. Never adds genre, era, or aesthetic meaning.
const LocalSurfaceRealizer = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const FORBIDDEN = /펑키|장르|년대|풍\b|UK|Garage|하우스풍|재즈풍|미학|감성|향수|네온|몽환|시적/;

  const LEXICON = Object.freeze({
    "bass.syncopated": {
      conceptId: "bass.syncopated",
      aliases: ["bass_syncopated"],
      neutralText: "싱코페이션 베이스",
      realizations: [
        { text: "싱코페이션 베이스", style: "technical" },
        { text: "엇박을 타는 베이스", style: "natural" },
        { text: "박 사이를 파고드는 베이스", style: "descriptive" },
        { text: "엇박에 걸린 베이스 라인", style: "natural" }
      ]
    },
    "bass.kick.lock": {
      conceptId: "bass.kick.lock",
      aliases: ["bass_kick_lock"],
      neutralText: "킥과 맞물리는 베이스",
      realizations: [
        { text: "킥과 맞물리는 베이스", style: "natural" },
        { text: "킥과 베이스가 밀착된 하단", style: "technical" },
        { text: "킥에 붙는 베이스", style: "descriptive" }
      ]
    },
    "bass.offset_from_pulse": {
      conceptId: "bass.offset_from_pulse",
      neutralText: "박 사이를 비껴가는 베이스",
      realizations: [
        { text: "박 사이를 비껴가는 베이스", style: "descriptive" },
        { text: "엇박의 베이스", style: "natural" },
        { text: "펄스에서 어긋난 베이스", style: "technical" }
      ]
    },
    "bass.motion.walking": {
      conceptId: "bass.motion.walking",
      aliases: ["walking_bass"],
      neutralText: "순차 진행 베이스",
      realizations: [
        { text: "순차 진행 베이스", style: "technical" },
        { text: "걸어가는 베이스 라인", style: "natural" },
        { text: "한 음씩 이어지는 베이스", style: "descriptive" }
      ]
    },
    "bass.repetition": {
      conceptId: "bass.repetition",
      aliases: ["ostinato_bass", "bass_ostinato"],
      neutralText: "반복 베이스",
      realizations: [
        { text: "반복 베이스", style: "technical" },
        { text: "같은 형을 도는 베이스", style: "natural" },
        { text: "반복되는 베이스 모티프", style: "descriptive" }
      ]
    },
    "vocal.synth.layer": {
      conceptId: "vocal.synth.layer",
      neutralText: "보컬 중심의 신스층",
      realizations: [
        { text: "보컬 중심의 신스층", style: "technical" },
        { text: "보컬을 받치는 신스층", style: "natural" },
        { text: "보컬과 겹친 신스 레이어", style: "descriptive" }
      ]
    },
    "sample.cell.repeat": {
      conceptId: "sample.cell.repeat",
      aliases: ["production_sample_loop"],
      neutralText: "짧은 샘플 셀의 반복",
      templates: [
        { style: "natural", behavior: ["반복되는", "짧은"], material: ["샘플 셀"], require: [] },
        { style: "descriptive", behavior: ["잘게 끊긴", "반복되는"], material: ["보컬 조각", "보컬 샘플"], require: ["vocal_chop"] }
      ],
      realizations: [
        { text: "짧은 샘플 셀의 반복", style: "descriptive" },
        { text: "반복되는 샘플 셀", style: "technical" }
      ]
    },
    "arrangement.thinning": {
      conceptId: "arrangement.thinning",
      aliases: ["arrangement_layer_exit"],
      neutralText: "저역이 빠지며 비워지는 편성",
      realizations: [
        { text: "저역이 빠지며 비워지는 편성", style: "descriptive" },
        { text: "레이어가 줄어든 구간", style: "natural" },
        { text: "밀도가 낮아진 편성", style: "technical" }
      ]
    },
    "arrangement.build": {
      conceptId: "arrangement.build",
      aliases: ["arrangement_build"],
      neutralText: "밀도가 높아지는 전환부",
      realizations: [
        { text: "밀도가 높아지는 전환부", style: "natural" },
        { text: "레이어가 쌓이는 전개", style: "technical" },
        { text: "밀도가 커지는 구간", style: "descriptive" }
      ]
    },
    "arrangement.open_after_transition": {
      conceptId: "arrangement.open_after_transition",
      neutralText: "구간 전환 뒤 넓어지는 레이어",
      realizations: [
        { text: "구간 전환 뒤 넓어지는 레이어", style: "descriptive" },
        { text: "전환 뒤 넓어진 편성", style: "natural" }
      ]
    },
    "percussion.densifying": {
      conceptId: "percussion.densifying",
      aliases: ["dense_subdivision"],
      neutralText: "타악기가 촘촘해지는 구간",
      realizations: [
        { text: "타악기가 촘촘해지는 구간", style: "natural" },
        { text: "촘촘해진 타악기 패턴", style: "technical" }
      ]
    },
    "production.filter.with_density": {
      conceptId: "production.filter.with_density",
      aliases: ["production_filter_motion"],
      neutralText: "필터 변화와 함께 커지는 밀도",
      realizations: [
        { text: "필터 변화와 함께 커지는 밀도", style: "descriptive" },
        { text: "필터가 열리며 밀도가 커지는 층", style: "technical" }
      ]
    },
    "production.sidechain.pump": {
      conceptId: "production.sidechain.pump",
      aliases: ["periodic_ducking"],
      neutralText: "킥에 눌리는 저역",
      realizations: [
        { text: "킥에 눌리는 저역", style: "natural" },
        { text: "사이드체인 펌핑", style: "technical" },
        { text: "킥에 따라 움직이는 저역", style: "descriptive" }
      ]
    },
    "melody.call_response": {
      conceptId: "melody.call_response",
      aliases: ["melody_call_response", "lead_exchange"],
      neutralText: "주고받는 프레이징",
      realizations: [
        { text: "주고받는 프레이징", style: "technical" },
        { text: "묻고 답하는 선율", style: "natural" },
        { text: "맞받아치는 짧은 프레이즈", style: "descriptive" }
      ]
    },
    "melody.contour": {
      conceptId: "melody.contour",
      aliases: ["melody_ascending_contour"],
      neutralText: "상행 선율",
      realizations: [
        { text: "상행 선율", style: "technical" },
        { text: "위로 열리는 선율", style: "natural" },
        { text: "조금씩 올라가는 멜로디", style: "descriptive" }
      ]
    },
    "rhythm.four_on_floor": {
      conceptId: "rhythm.four_on_floor",
      aliases: ["straight_four", "four_on_floor"],
      neutralText: "4/4 킥",
      realizations: [
        { text: "4/4 킥", style: "technical" },
        { text: "박마다 찍히는 킥", style: "natural" },
        { text: "네 박을 채우는 킥", style: "descriptive" }
      ]
    },
    "rhythm.syncopation": {
      conceptId: "rhythm.syncopation",
      aliases: ["offbeat_accent", "rhythm_syncopated_grid"],
      neutralText: "오프비트 강세",
      realizations: [
        { text: "오프비트 강세", style: "technical" },
        { text: "엇박에 실리는 액센트", style: "natural" },
        { text: "박 사이에 걸리는 강세", style: "descriptive" }
      ]
    },
    "texture.thin_low_end": {
      conceptId: "texture.thin_low_end",
      neutralText: "밀도에 비해 얇은 저역",
      realizations: [
        { text: "밀도에 비해 얇은 저역", style: "technical" },
        { text: "저역이 비운 밀도", style: "descriptive" }
      ]
    },
    "vocal.ahead_of_bass": {
      conceptId: "vocal.ahead_of_bass",
      neutralText: "저역보다 앞선 보컬",
      realizations: [
        { text: "저역보다 앞선 보컬", style: "technical" },
        { text: "베이스보다 앞에 선 보컬", style: "natural" }
      ]
    },
    "form.section_transition": {
      conceptId: "form.section_transition",
      aliases: ["arrangement_foreground_shift"],
      neutralText: "구간이 바뀌는 전환부",
      realizations: [
        { text: "구간이 바뀌는 전환부", style: "natural" },
        { text: "새 구간 전환", style: "technical" }
      ]
    }
  });

  const ALIAS = new Map();
  const SURFACE_TO_CONCEPT = new Map();
  for (const [id, entry] of Object.entries(LEXICON)) {
    ALIAS.set(id, entry);
    for (const alias of entry.aliases || []) ALIAS.set(alias, entry);
    registerSurfaces(entry);
  }

  function registerSurfaces(entry) {
    const texts = [entry.neutralText, ...(entry.realizations || []).map(item => item.text)];
    for (const form of expandTemplates(entry, {})) texts.push(form.text);
    for (const text of texts) {
      if (text) SURFACE_TO_CONCEPT.set(String(text).toLowerCase(), entry.conceptId);
    }
  }

  function expandTemplates(entry, claims = {}) {
    const licensed = claims.licensed instanceof Set ? claims.licensed
      : new Set(Object.keys(claims.byConcept || {}));
    const forms = [];
    for (const template of entry.templates || []) {
      if ((template.require || []).some(concept => !licensed.has(concept))) continue;
      for (const behavior of template.behavior || []) {
        for (const material of template.material || []) {
          const text = `${behavior} ${material}`.replace(/\s+/g, " ").trim();
          if (!FORBIDDEN.test(text) && Facets.safeText(text, "production"))
            forms.push({ text, style: template.style || "natural", fromTemplate: true });
        }
      }
    }
    return forms;
  }

  function entryFor(item = {}) {
    const id = item.conceptId || item.relationId || item.idiomId || item.id;
    if (id && ALIAS.has(id)) return ALIAS.get(id);
    if (id && ALIAS.has(String(id).replace(/-/g, "_"))) return ALIAS.get(String(id).replace(/-/g, "_"));
    const text = String(item.canonicalText || item.neutralText || item.text || "").toLowerCase();
    const mapped = SURFACE_TO_CONCEPT.get(text);
    return mapped ? ALIAS.get(mapped) : null;
  }

  function allowedForms(entry, claims = {}) {
    const forms = [];
    const seen = new Set();
    const push = form => {
      if (!form?.text || seen.has(form.text) || FORBIDDEN.test(form.text)) return;
      if (!Facets.safeText(form.text, "arrangement") && !Facets.safeText(form.text, "performance")
        && !Facets.safeText(form.text, "production") && !Facets.safeText(form.text, "rhythm")) return;
      seen.add(form.text);
      forms.push(form);
    };
    push({ text: entry.neutralText, style: "technical" });
    for (const form of entry.realizations || []) push(form);
    for (const form of expandTemplates(entry, claims)) push(form);
    return forms;
  }

  class Engine {
    constructor({ cooldownMs = 8000 } = {}) {
      this.cooldownMs = cooldownMs;
      this.byConcept = new Map();
    }

    reset() {
      this.byConcept.clear();
    }

    metadata(conceptId) {
      return this.byConcept.get(conceptId) || { lastShownAt: 0, showCount: 0, lastSurface: null, cooldown: this.cooldownMs };
    }

    formsFor(item, claims) {
      const entry = entryFor(item);
      return entry ? allowedForms(entry, claims) : [];
    }

    enrich(item, claims) {
      const entry = entryFor(item);
      if (!entry) {
        const conceptId = item.conceptId || item.relationId || item.idiomId || item.id || null;
        return conceptId ? { ...item, conceptId } : { ...item };
      }
      const realizations = allowedForms(entry, claims);
      return {
        ...item,
        conceptId: entry.conceptId,
        canonicalText: entry.neutralText,
        realizations,
        text: item.text || entry.neutralText
      };
    }

    pickFromRecent(item, recent = [], claims = {}) {
      const enriched = this.enrich(item, claims);
      if (!enriched.realizations?.length) return enriched;
      const last = [...recent].reverse().find(previous =>
        (previous?.conceptId || conceptIdOf(previous)) === enriched.conceptId);
      if (!last) return { ...enriched, text: item.text || enriched.canonicalText, surfaceStyle: "technical" };
      const next = enriched.realizations.find(form => form.text !== (last.text || last)) || enriched.realizations[0];
      return { ...enriched, text: next.text, surfaceStyle: next.style };
    }

    choose(item, { now = Date.now(), recent = [], claims = {}, preferStyle = null } = {}) {
      const enriched = this.enrich(item, claims);
      const forms = enriched.realizations;
      if (!forms?.length) return enriched;
      const conceptId = enriched.conceptId;
      const meta = this.metadata(conceptId);
      const recentSame = recent.some(previous => {
        const previousId = previous?.conceptId || SURFACE_TO_CONCEPT.get(String(previous?.text || previous || "").toLowerCase());
        return previousId === conceptId;
      });
      const cooling = recentSame || (meta.showCount > 0 && now - meta.lastShownAt < this.cooldownMs);
      if (cooling && meta.lastSurface) {
        return { ...enriched, text: meta.lastSurface, surfaceStyle: "held", lastShownAt: meta.lastShownAt,
          showCount: meta.showCount, lastSurface: meta.lastSurface, cooldown: true };
      }
      const different = forms.filter(form => form.text !== meta.lastSurface);
      const styled = preferStyle ? (different.filter(form => form.style === preferStyle)[0] ? different.filter(form => form.style === preferStyle) : different) : different;
      const pool = styled.length ? styled : forms;
      const pick = preferStyle
        ? pool.find(form => form.style === preferStyle) || pool[0]
        : pool[meta.showCount % pool.length];
      const next = {
        lastShownAt: now,
        showCount: meta.showCount + 1,
        lastSurface: pick.text,
        cooldown: this.cooldownMs
      };
      this.byConcept.set(conceptId, next);
      return {
        ...enriched,
        text: pick.text,
        surfaceStyle: pick.style,
        lastShownAt: next.lastShownAt,
        showCount: next.showCount,
        lastSurface: next.lastSurface,
        cooldown: false
      };
    }
  }

  const shared = new Engine();

  function conceptIdOf(input) {
    if (typeof input === "object" && (input.conceptId || input.relationId))
      return String(input.conceptId || input.relationId);
    const text = String(typeof input === "object" ? input.text : input || "").toLowerCase();
    return SURFACE_TO_CONCEPT.get(text) || null;
  }

  return {
    Engine, LEXICON, FORBIDDEN, entryFor, allowedForms, expandTemplates, conceptIdOf,
    SURFACE_TO_CONCEPT, enrich: (item, claims) => shared.enrich(item, claims),
    choose: (item, options) => shared.choose(item, options),
    pickFromRecent: (item, recent, claims) => shared.pickFromRecent(item, recent, claims),
    applyToItems: (items, options) => (items || []).map(item => shared.enrich(item, options?.claims)),
    reset: () => shared.reset(),
    shared
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LocalSurfaceRealizer;
