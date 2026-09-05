const InstrumentationEvents = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = Facets.clamp;
  const labels = {
    voice: "보컬", vocal: "보컬", vocals: "보컬", drums: "드럼", percussion: "퍼커션",
    beat: "비트", bell: "벨", bongo: "봉고", drummachine: "드럼 머신",
    bass: "베이스", acousticbassguitar: "어쿠스틱 베이스 기타", doublebass: "더블 베이스",
    electricbass: "일렉트릭 베이스", synthesizer: "신스", synth: "신스", pad: "신스 패드",
    sampler: "샘플러", computer: "전자음",
    piano: "피아노", electricpiano: "일렉트릭 피아노", acousticpiano: "어쿠스틱 피아노",
    rhodes: "로즈 피아노", keyboard: "키보드", pipeorgan: "파이프 오르간",
    electricguitar: "일렉트릭 기타", acousticguitar: "어쿠스틱 기타", classicalguitar: "클래식 기타", guitar: "기타",
    strings: "스트링", orchestra: "오케스트라", saxophone: "색소폰", trumpet: "트럼펫",
    brass: "브라스", trombone: "트롬본", horn: "호른", flute: "플루트", organ: "오르간",
    cello: "첼로", viola: "비올라", violin: "바이올린",
    "베이스라인": "베이스", "피아노·건반": "피아노", "신스 패드·지속 화음": "신스 패드", "드럼·퍼커션": "퍼커션"
  };
  const FAMILIES = Object.freeze({
    brass: ["trumpet", "trombone", "brass", "horn", "tuba"], reed: ["saxophone", "clarinet", "oboe", "bassoon"],
    flute: ["flute", "recorder", "piccolo"], bowed: ["violin", "viola", "cello", "contrabass", "strings", "orchestra"],
    plucked: ["guitar", "acousticguitar", "electricguitar", "classicalguitar", "banjo", "harp", "koto", "sitar"],
    keys: ["piano", "electricpiano", "acousticpiano", "rhodes", "keyboard", "organ", "pipeorgan", "harpsichord", "accordion"],
    synth: ["synthesizer", "synthpad", "synthlead", "pad", "computer", "sampler"],
    bass: ["bass", "electricbass", "acousticbassguitar", "doublebass"],
    percussion: ["beat", "bongo", "drummachine", "drums", "percussion", "timpani"],
    voice: ["voice", "vocal", "choir"]
  });
  const MELODIC_FAMILIES = new Set(["brass", "reed", "flute", "bowed", "plucked", "keys", "synth", "voice"]);
  const canonicalId = label => {
    const key = String(label || "").toLowerCase().replace(/[ _-]/g, "");
    return ({ vocal: "voice", vocals: "voice", synth: "synthesizer", "베이스라인": "bass",
      "피아노·건반": "piano", "드럼·퍼커션": "percussion", "신스 패드·지속 화음": "synthpad" })[key] || key;
  };
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  function normalize(instruments = []) {
    const result = new Map();
    for (const item of instruments.slice(0, 24)) {
      if (!item?.label || !Number.isFinite(item.confidence)) continue;
      const id = canonicalId(item.label);
      const normalized = { id, label: labels[String(item.label).toLowerCase()] || labels[id] || item.label,
        confidence: clamp(item.confidence), source: item.source || "model",
        rawConfidence: Number.isFinite(item.rawConfidence) ? clamp(item.rawConfidence) : undefined,
        observationId: item.observationId ?? null,
        observedAt: Number.isFinite(item.observedAt) ? item.observedAt : null };
      const previous = result.get(id);
      if (!previous || normalized.confidence > previous.confidence) result.set(id, normalized);
    }
    return [...result.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  }
  function familyRollup(observed = []) {
    const output = {};
    for (const [family, members] of Object.entries(FAMILIES)) {
      const matches = observed.filter(item => members.includes(item.id));
      if (!matches.length) continue;
      output[family] = { confidence: clamp(1 - matches.reduce((product, item) => product * (1 - clamp(item.confidence)), 1)),
        melodic: MELODIC_FAMILIES.has(family), members: matches.map(item => item.id) };
    }
    return output;
  }
  function dominanceDispersion(observed = []) {
    if (!observed.length) return null;
    if (observed.length === 1) return 0;
    const total = observed.reduce((sum, item) => sum + clamp(item.confidence), 0);
    if (!total) return null;
    const probabilities = observed.map(item => clamp(item.confidence) / total).filter(Boolean);
    return clamp(-probabilities.reduce((sum, value) => sum + value * Math.log(value), 0) / Math.log(probabilities.length));
  }
  // Counts instruments that stayed both confident and dominant across most of a recent stretch
  // of frames — a sustained, converging estimate of "how many distinct instruments are audibly
  // active at once", not a claim about the actual number of performers.
  function stableEnsembleSize(frames, { minConfidence = 0.5, minDominance = 0.12, minFrames = 8, minRatio = 0.8 } = {}) {
    if (frames.length < minFrames) return null;
    const recent = frames.slice(-minFrames);
    const counts = new Map();
    for (const frame of recent) {
      for (const item of frame.observed) {
        if (item.confidence >= minConfidence && item.dominance >= minDominance) counts.set(item.id, (counts.get(item.id) || 0) + 1);
      }
    }
    const core = [...counts.entries()].filter(([, count]) => count >= recent.length * minRatio);
    return core.length >= 2 ? core.length : null;
  }
  function performance(observed, frames, f) {
    const top = observed[0], second = observed[1]?.confidence || 0;
    const earlier = frames.slice(0, -2);
    const baseline = mean(earlier.map(frame => frame.observed.find(x => x.id === top?.id)?.confidence || 0));
    const baselineDensity = mean(earlier.map(frame => frame.density));
    const melodic = Number.isFinite(f.melodicActivity) ? clamp(f.melodicActivity) : null;
    const pitch = Number.isFinite(f.pitchActivity) ? clamp(f.pitchActivity) : null;
    const accompanimentDelta = Number.isFinite(f.accompanimentDensity) && earlier.length ? f.accompanimentDensity - baselineDensity : null;
    const precedingTop = frames.at(-1)?.observed.find(item => item.id === top?.id)?.confidence || 0;
    const supportedSolo = top && frames.length >= 5 && precedingTop >= 0.7 && top.confidence >= 0.8 && top.confidence - second >= 0.3 &&
      top.confidence - baseline > 0.18 && accompanimentDelta < -0.15 && melodic >= 0.7 && pitch >= 0.65 && f.onsetActivity >= 0.4;
    const soloLikelihood = supportedSolo ? Math.min(top.confidence, melodic, pitch, 0.95) : 0;
    const leadSupported = top && top.confidence >= 0.65 && top.confidence - second >= 0.18 && melodic >= 0.55 && pitch >= 0.5;
    const foregroundSupported = top && top.confidence >= 0.55 && top.confidence - baseline >= 0.1;
    // Walking bass is stepwise pitch + a regular pulse, not "the bass moved a lot". Live mix FFT
    // walking lines often have modest bin-motion; walkingEvidence is the semitone stepwise score.
    const bass = observed.find(x => /bass/.test(x.id));
    const walkingScore = Number.isFinite(f.walkingEvidence) ? clamp(f.walkingEvidence)
      : Number.isFinite(f.bassPitchMotion) && Number.isFinite(f.bassOnsetRegularity)
        ? Math.min(f.bassPitchMotion, f.bassOnsetRegularity) : null;
    const walking = bass?.confidence >= 0.65 && walkingScore !== null
      ? Math.min(bass.confidence, walkingScore) : null;
    let bassFunction = null;
    if (!bass || bass.confidence < 0.45) bassFunction = "none";
    else if (walking >= 0.7) bassFunction = "walking";
    else if (Number.isFinite(f.bassPitchMotion) && f.bassPitchMotion < 0.15) bassFunction = "static";
    else if (Number.isFinite(f.bassPatternRepetition) && f.bassPatternRepetition >= 0.7) bassFunction = "ostinato";
    else if (Number.isFinite(f.bassPitchMotion) && f.bassPitchMotion >= 0.65) bassFunction = "melodic";
    return { soloLikelihood, soloInstrument: soloLikelihood >= 0.8 ? top.label : null,
      walkingBassLikelihood: walking, melodicActivity: melodic, pitchActivity: pitch,
      onsetActivity: Number.isFinite(f.onsetActivity) ? clamp(f.onsetActivity) : null,
      dominanceChange: top ? top.confidence - baseline : 0, accompanimentDelta,
      leadLikelihood: leadSupported ? Math.min(top.confidence, melodic, pitch) : null,
      leadInstrument: leadSupported ? top.label : null,
      foregroundInstrument: foregroundSupported ? top.label : null,
      foregroundLikelihood: foregroundSupported ? Math.min(top.confidence, clamp(0.5 + top.confidence - baseline)) : null,
      bassPitchMotion: Number.isFinite(f.bassPitchMotion) ? clamp(f.bassPitchMotion) : null,
      bassOnsetRegularity: Number.isFinite(f.bassOnsetRegularity) ? clamp(f.bassOnsetRegularity) : null,
      bassPatternRepetition: Number.isFinite(f.bassPatternRepetition) ? clamp(f.bassPatternRepetition) : null,
      bassSyncopation: Number.isFinite(f.bassSyncopation) ? clamp(f.bassSyncopation) : null,
      bassKickInteraction: Number.isFinite(f.bassKickInteraction) ? clamp(f.bassKickInteraction) : null,
      walkingEvidence: Number.isFinite(f.walkingEvidence) ? clamp(f.walkingEvidence) : null,
      bassStepwiseRatio: Number.isFinite(f.bassStepwiseRatio) ? clamp(f.bassStepwiseRatio) : null,
      bassPitchClassHistogram: Array.isArray(f.bassPitchClassHistogram) ? f.bassPitchClassHistogram : null,
      dominantBassPitchClass: Number.isInteger(f.dominantBassPitchClass) ? f.dominantBassPitchClass : null,
      rootFollowing: Number.isFinite(f.rootFollowing) ? clamp(f.rootFollowing) : null,
      bassArticulation: typeof f.bassArticulation === "string" ? f.bassArticulation : null,
      bassFunction, resolution: "mixture-level temporal proxy; harmonic residual when HPSS is ready, not source separation" };
  }
  function candidateTokens(observed = [], events = [], perf = {}) {
    const candidates = [];
    observed.forEach((item, index) => {
      if (item.confidence < 0.35 || item.source === "dsp") return;
      candidates.push(Facets.token(item.label, "instrumentation", item.confidence,
        ["instrumentation.observed." + index + ".confidence"], { source: "instrument" }));
    });
    events.forEach((event, index) => candidates.push(Facets.token(event.text, "live", event.confidence,
      ["instrumentEvents." + index + ".confidence"], { source: "instrument", layer: "LIVE",
        deltaSource: "instrument-dominance-history", deltaMagnitude: event.confidence })));
    if (perf.soloLikelihood >= 0.8 && perf.soloInstrument) candidates.push(Facets.token(perf.soloInstrument + " 솔로", "performance", perf.soloLikelihood,
      ["performance.soloLikelihood", "instrumentation.observed.0.confidence"], { source: "instrument" }));
    if (perf.leadLikelihood >= 0.65 && perf.leadInstrument) candidates.push(Facets.token(perf.leadInstrument + " 리드", "performance", perf.leadLikelihood,
      ["performance.leadLikelihood", "performance.leadInstrument", "instrumentation.observed.0.confidence"], { source: "instrument" }));
    if (perf.walkingBassLikelihood >= 0.8) candidates.push(Facets.token("워킹 베이스", "performance", perf.walkingBassLikelihood,
      ["performance.walkingBassLikelihood", "instrumentation.observed"], { source: "instrument" }));
    return candidates.slice(0, 20);
  }
  class Engine {
    constructor({ capacity = 48, historyMs = 12000, eventTtlMs = 3500 } = {}) {
      Object.assign(this, { capacity, historyMs, eventTtlMs }); this.reset();
    }
    reset() { this.frames = []; this.events = []; this.lastAt = -Infinity; this.lastObservationId = null; this.current = null; }
    update(instruments = [], features = {}, at = Date.now()) {
      if (at - this.lastAt < 350) return this.current;
      this.lastAt = at;
      const observed = normalize(instruments.filter(x => x.source !== "dsp"));
      const eventObserved = normalize((features.eventInstruments || instruments).filter(x => x.source !== "dsp"));
      const observationId = features.observationId ?? eventObserved.find(item => item.observationId !== null)?.observationId ?? null;
      const isNewObservation = observationId === null || observationId !== this.lastObservationId;
      const history = this.frames.filter(frame => at - frame.at <= this.historyMs);
      const addDominance = items => {
        const total = items.reduce((sum, item) => sum + item.confidence, 0);
        items.forEach(item => { item.dominance = item.confidence / Math.max(0.001, total); });
      };
      addDominance(observed);
      addDominance(eventObserved);
      const families = familyRollup(observed);
      const dispersion = dominanceDispersion(observed);
      if (!isNewObservation) {
        this.events = this.events.filter(event => at - event.at <= this.eventTtlMs).slice(-12);
        const perf = this.current?.performance || performance(eventObserved, history, features);
        const top = observed[0];
        const candidates = candidateTokens(observed, this.events, perf);
        this.current = { instrumentation: { observed, families, dominanceDispersion: dispersion,
            leadTransitionRate: this.current?.instrumentation?.leadTransitionRate ?? null,
            confidence: top?.confidence || 0, resolution: "temporally smoothed model presence; no source separation" },
          instrumentEvents: this.events.map(event => ({ ...event })), performance: perf,
          arrangement: { density: features.accompanimentDensity ?? null, accompanimentDelta: perf.accompanimentDelta,
            dominantRole: top?.confidence >= 0.65 ? top.label : null,
            verifiedEnsembleSize: stableEnsembleSize(this.frames) },
          instrumentFacetCandidates: candidates.slice(0, 20) };
        return this.current;
      }
      this.lastObservationId = observationId;
      const perf = performance(eventObserved, history, features);
      const leadIds = [...history.map(frame => frame.observed[0]?.id), eventObserved[0]?.id].filter(Boolean);
      const transitions = leadIds.slice(1).reduce((count, id, index) => count + (id !== leadIds[index] ? 1 : 0), 0);
      const leadTransitionRate = history.length >= 2 ? transitions / Math.max(1, (at - history[0].at) / 1000) : null;
      const addEvent = (item, text, kind, confidence) => {
        if (this.events.some(event => event.instrument === item.id && event.kind === kind && at - event.at < this.eventTtlMs)) return;
        this.events.push({ text, instrument: item.id, kind, confidence, at });
      };
      for (const item of eventObserved) {
        const before = history.slice(0, -1).map(frame => frame.observed.find(x => x.id === item.id)?.confidence || 0);
        const sustained = history.at(-1)?.observed.find(x => x.id === item.id)?.confidence >= 0.55;
        if (before.length >= 3 && mean(before) <= 0.3 && item.confidence >= 0.65 && sustained)
          addEvent(item, item.id === "voice" ? "보컬 유입" : item.label + " 등장", "entrance", item.confidence);
      }
      // An exit is a temporal observation, not the absence of a class in one frame. Require a
      // sustained earlier presence and several historical frames before emitting it.
      const previousIds = new Set(history.flatMap(frame => frame.observed.map(item => item.id)));
      for (const id of previousIds) {
        const previous = history.map(frame => frame.observed.find(item => item.id === id)).filter(Boolean);
        if (previous.length < 4) continue;
        const baselineConfidence = mean(previous.map(item => item.confidence));
        const current = eventObserved.find(item => item.id === id);
        if (baselineConfidence >= 0.6 && (!current || current.confidence <= 0.25)) {
          const exemplar = previous.at(-1);
          addEvent(exemplar, id === "voice" ? "보컬 이탈" : exemplar.label + " 이탈", "exit", baselineConfidence);
        }
      }
      const eventTop = eventObserved[0];
      if (perf.leadLikelihood >= 0.8 && perf.dominanceChange > 0.2 && history.length >= 4 && eventTop)
        addEvent(eventTop, eventTop.label + " 리드 유입", "lead", perf.leadLikelihood);
      this.events = this.events.filter(event => at - event.at <= this.eventTtlMs).slice(-12);
      this.frames = [...history, { at, observationId, observed: eventObserved,
        density: Number.isFinite(features.accompanimentDensity) ? features.accompanimentDensity : 0.5 }].slice(-this.capacity);
      const candidates = candidateTokens(observed, this.events, perf);
      const top = observed[0];
      this.current = { instrumentation: { observed, families, dominanceDispersion: dispersion, leadTransitionRate,
          confidence: top?.confidence || 0, resolution: "temporally smoothed model presence; no source separation" },
        instrumentEvents: this.events.map(event => ({ ...event })), performance: perf,
        arrangement: { density: features.accompanimentDensity ?? null, accompanimentDelta: perf.accompanimentDelta,
          dominantRole: top?.confidence >= 0.65 ? top.label : null, verifiedEnsembleSize: stableEnsembleSize(this.frames) },
        instrumentFacetCandidates: candidates.slice(0, 20) };
      return this.current;
    }
  }
  return { Engine, normalize, performance, candidateTokens, canonicalId, stableEnsembleSize, familyRollup, dominanceDispersion, FAMILIES };
})();
if (typeof module !== "undefined" && module.exports) module.exports = InstrumentationEvents;
