const SemanticFusion = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const dimensions = ["valence", "arousal", "tension", "warmth", "brightness", "spaciousness"];

  function fuseMood(local = {}, ml = {}, mlReady = false) {
    const result = {};
    for (const key of dimensions) {
      const localValue = clamp(local[key] ?? 0.5);
      const semanticValue = clamp(ml[key] ?? localValue);
      const localWeight = ["arousal", "tension", "brightness"].includes(key) ? 0.78 : 0.66;
      result[key] = mlReady
        ? localValue * localWeight + semanticValue * (1 - localWeight)
        : localValue;
    }
    return result;
  }

  function visualFromState(mood = {}, audio = {}, genre = {}) {
    const valence = clamp(mood.valence ?? 0.5);
    const arousal = clamp(mood.arousal ?? 0.5);
    const tension = clamp(mood.tension ?? 0.35);
    const warmth = clamp(mood.warmth ?? 0.5);
    const brightness = clamp(mood.brightness ?? 0.5);
    const spaciousness = clamp(mood.spaciousness ?? 0.5);
    const baseHue = (210 + valence * 105 - warmth * 38 + tension * 48 + 360) % 360;
    return {
      primaryHue: genre.paletteHue ?? baseHue,
      secondaryHue: (baseHue + 78 + spaciousness * 42) % 360,
      saturation: clamp(0.48 + tension * 0.28 + arousal * 0.18),
      brightness: clamp(0.5 + brightness * 0.38 + valence * 0.1),
      pulse: clamp(0.25 + arousal * 0.58 + (audio.beatConfidence || 0) * 0.17),
      turbulence: clamp(0.12 + tension * 0.5 + (audio.flux || 0) * 4),
      density: clamp(0.28 + arousal * 0.36 + spaciousness * 0.2)
    };
  }

  return { fuseMood, visualFromState, dimensions };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SemanticFusion;
