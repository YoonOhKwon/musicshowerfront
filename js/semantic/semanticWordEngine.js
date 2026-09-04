class LocalSemanticWordEngine {
  constructor() {
    this.dictionary = { neutral: [["빛", 1], ["파동", 1], ["잔광", 0.9], ["맥동", 0.9], ["흐름", 0.8]] };
    this.ready = false;
  }

  async initialize(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`dictionary HTTP ${response.status}`);
      this.dictionary = await response.json();
      this.ready = true;
    } catch (error) {
      console.warn("[semantic words] neutral fallback", error.message);
    }
  }

  token(text, weight, category) {
    return { text, weight: SignalMath.clamp(weight, 0.05, 1), category };
  }

  append(target, entries, category, multiplier = 1) {
    for (const [text, weight] of entries || []) {
      const adjusted = SignalMath.clamp(weight * multiplier, 0.05, 1);
      const current = target.get(text);
      if (!current || adjusted > current.weight) target.set(text, this.token(text, adjusted, category));
    }
  }

  appendMatchingGroups(target, groups, label, category, multiplier = 1) {
    const normalized = String(label || "").toLowerCase();
    for (const group of Object.values(groups || {})) {
      if ((group.labels || []).some(candidate => candidate.toLowerCase() === normalized)) {
        this.append(target, group.words, category, multiplier);
      }
    }
  }

  generate(state) {
    const words = new Map();
    const hasMusicalEvidence = (state.trackCharacter?.confidence || 0) > 0.12 || Boolean(state.ml?.lastUpdated);
    if (!hasMusicalEvidence) this.append(words, this.dictionary.neutral, "neutral", 0.88);
    const mood = state.mood?.fused || {};
    if ((mood.arousal || 0) > 0.62) this.append(words, this.dictionary.mood?.energetic, "mood", mood.arousal);
    if ((mood.arousal || 1) < 0.38) this.append(words, this.dictionary.mood?.calm, "mood", 1 - mood.arousal);
    if ((mood.tension || 0) > 0.58) this.append(words, this.dictionary.mood?.tense, "mood", mood.tension);
    if ((mood.brightness || 0) > 0.6) this.append(words, this.dictionary.mood?.bright, "mood", mood.brightness);
    if ((mood.brightness || 1) < 0.38) this.append(words, this.dictionary.mood?.dark, "mood", 1 - mood.brightness);
    if ((mood.warmth || 0) > 0.62) this.append(words, this.dictionary.mood?.warm, "mood", mood.warmth);
    if ((mood.spaciousness || 0) > 0.6) this.append(words, this.dictionary.mood?.spacious, "space", mood.spaciousness);

    const audio = state.audio || {};
    if ((audio.bass || 0) > 0.25) this.append(words, this.dictionary.dsp?.bass, "dsp", audio.bass + 0.35);
    if ((audio.flux || 0) > 0.015) this.append(words, this.dictionary.dsp?.transient, "dsp", audio.flux * 10 + 0.35);
    if ((audio.beatConfidence || 0) > 0.35) this.append(words, this.dictionary.dsp?.pulse, "rhythm", audio.beatConfidence);
    if ((audio.tonalFocus || 0) > 0.24) this.append(words, this.dictionary.dsp?.tonal, "harmony", audio.tonalFocus + 0.3);
    if ((audio.flatness || 0) > 0.35) this.append(words, this.dictionary.dsp?.noisy, "texture", audio.flatness);

    for (const instrument of state.instruments || []) {
      this.appendMatchingGroups(words, this.dictionary.instrumentGroups, instrument.label, "instrument", instrument.confidence);
    }
    for (const tag of state.mood?.labels || []) {
      this.appendMatchingGroups(words, this.dictionary.moodTagGroups, tag.label, "mood", tag.confidence);
    }
    this.append(words, this.dictionary.family?.[state.genre?.family], "genre-family", Math.max(0.28, state.genre?.confidence || 0));
    if (state.genre?.certainty === "hybrid") {
      this.append(words, this.dictionary.genreState?.hybrid, "genre-state", state.genre.confidence + 0.15);
    } else if (state.genre?.uncertain) {
      this.append(words, this.dictionary.genreState?.uncertain, "genre-state", 0.55);
    }
    if (!state.genre?.uncertain && state.genre?.confidence >= 0.34) {
      this.append(words, this.dictionary.genre?.[state.genre.primary], "genre", state.genre.confidence);
    }
    if (state.novelty?.transitionDetected) {
      this.append(words, this.dictionary.transition, "transition", state.novelty.score);
    }
    return [...words.values()].sort((left, right) => right.weight - left.weight).slice(0, 28);
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = LocalSemanticWordEngine;
