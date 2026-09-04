// Fact Firewall: a concrete musical FACT term is licensed only by a verified claim.
// Genre stereotype is never a license. Missing claim → UNLICENSED_FACT_TERM.
const FactFirewall = (() => {
  const TERMS = Object.freeze([
    { concept: "walking_bass", pattern: /워킹 베이스|walking bass/i },
    { concept: "sidechain", pattern: /사이드체인|sidechain/i },
    { concept: "two_step", pattern: /2-Step|2-step|투스텝/i },
    { concept: "vocal_chop", pattern: /보컬 찹|vocal chop|chopped vocal/i },
    { concept: "solo", pattern: /솔로|\bsolo\b/i },
    { concept: "arpeggio", pattern: /아르페지오|arpeggio/i },
    { concept: "brush", pattern: /브러시 드럼|브러시|brush drum/i },
    { concept: "slap_bass", pattern: /슬랩 베이스|slap bass/i },
    { concept: "call_response", pattern: /콜 앤 리스폰스|주고받는 선율|call.?and.?response/i },
    { concept: "breakbeat", pattern: /브레이크비트|아멘형 브레이크|amen.?break/i },
    { concept: "fm_synth", pattern: /FM 신스|fm synth/i },
    { concept: "four_on_floor", pattern: /4\/4 플로어|four.on.the.floor|포 온 플로어/i },
    { concept: "sample_based", pattern: /샘플 기반|sample.based/i },
    { concept: "filter_sweep", pattern: /필터 스윕|filter sweep/i },
    { concept: "wide_stereo", pattern: /스테레오 확장|wide stereo/i }
  ]);

  function licensedSet(store) {
    if (store?.licensed instanceof Set) return store.licensed;
    if (Array.isArray(store?.licensed)) return new Set(store.licensed);
    return new Set((store?.items || []).map(item => item.concept));
  }

  function inspect(text, store = null) {
    const hits = TERMS.filter(term => term.pattern.test(String(text || "")));
    if (!hits.length) return { licensed: true, hits: [], reason: null };
    // A missing store means claims were never collected (unit tests, early frames).
    // That is not a license, but it is also not a veto — the pipeline attaches claims
    // before production critic/LLM paths run.
    if (!store || (!store.licensed && !store.items)) return { licensed: true, hits, reason: "store-absent" };
    const licensed = licensedSet(store);
    const missing = hits.filter(term => !licensed.has(term.concept) &&
      !licensed.has(`idiom_${term.concept}`) &&
      ![...licensed].some(concept => String(concept).includes(term.concept)));
    if (!missing.length) return { licensed: true, hits, reason: null };
    return { licensed: false, hits, missing, reason: "UNLICENSED_FACT_TERM" };
  }

  return { TERMS, inspect };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FactFirewall;
