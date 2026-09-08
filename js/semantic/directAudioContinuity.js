// Maintains a bounded, session-local interpretation across Music Flamingo captures.
// Momentary facts are replaced by the newest segment; track-level hypotheses may survive briefly
// with decaying confidence until a later segment corroborates, revises or lets them expire.
const DirectAudioContinuity = (() => {
  const PERSISTENT_CATEGORIES = new Set(["genre", "lineage", "era", "scene", "culture", "association", "mood"]);
  const normalize = text => String(text || "").toLowerCase().replace(/[\s_&'().,\-]+/g, "");
  const keyFor = item => `${item?.category || "unknown"}:${normalize(item?.text)}`;
  const persistent = item => PERSISTENT_CATEGORIES.has(item?.category) ||
    ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(item?.layer);

  function merge(previous = [], incoming = [], options = {}) {
    const now = Number(options.now) || Date.now();
    const maxAgeMs = Number(options.maxAgeMs) || 180000;
    const maxCandidates = Number(options.maxCandidates) || 32;
    const retentionDecay = Number(options.retentionDecay) || 0.90;
    const shiftedRetentionDecay = Number(options.shiftedRetentionDecay) || 0.40;
    const minimumRetainedConfidence = Number(options.minimumRetainedConfidence) || 0.45;
    const fresh = (Array.isArray(incoming) ? incoming : []).filter(item => item?.text).map(item => ({
      ...item,
      observedAt: now,
      retainedAcrossCaptures: false
    }));
    const freshKeys = new Set(fresh.map(keyFor));

    // A fresh capture whose genre reading doesn't match ANY currently-retained genre is evidence
    // the underlying song likely changed, even when no acoustic track-boundary fired (e.g. a
    // same-tempo DJ-mixed transition with no silence gap). Acoustic detection alone cannot safely
    // catch every such case without also misfiring on an ordinary section change, so this gives
    // old CONTEXT/AESTHETIC/IMPRESSION baggage a second, evidence-based way to turn over quickly
    // instead of riding out the full multi-minute retention window on a genre that no longer holds.
    const freshGenreKeys = new Set(fresh.filter(item => item.category === "genre").map(keyFor));
    const previousGenreKeys = new Set((Array.isArray(previous) ? previous : [])
      .filter(item => item.category === "genre").map(keyFor));
    const genreHypothesisShifted = freshGenreKeys.size > 0 && previousGenreKeys.size > 0 &&
      [...freshGenreKeys].every(key => !previousGenreKeys.has(key));
    const effectiveDecay = genreHypothesisShifted ? Math.min(retentionDecay, shiftedRetentionDecay) : retentionDecay;

    const retained = (Array.isArray(previous) ? previous : []).filter(item => {
      const observedAt = Number(item?.observedAt) || now;
      return item?.text && persistent(item) && !freshKeys.has(keyFor(item)) && now - observedAt <= maxAgeMs;
    }).map(item => {
      const confidence = Math.max(0, Math.min(1, (Number(item.confidence) || 0) * effectiveDecay));
      return { ...item, confidence, weight: confidence, resolutionMomentum: false, retainedAcrossCaptures: true };
    }).filter(item => item.confidence >= minimumRetainedConfidence)
      .sort((a, b) => b.confidence - a.confidence);
    return [...fresh, ...retained].slice(0, maxCandidates);
  }

  function active(candidates = [], options = {}) {
    const now = Number(options.now) || Date.now();
    const maxAgeMs = Number(options.maxAgeMs) || 180000;
    return (Array.isArray(candidates) ? candidates : []).filter(item =>
      !item?.observedAt || now - Number(item.observedAt) <= maxAgeMs);
  }

  return { merge, active, keyFor, persistent, PERSISTENT_CATEGORIES };
})();

if (typeof module !== "undefined" && module.exports) module.exports = DirectAudioContinuity;
