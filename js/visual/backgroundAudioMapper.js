const BackgroundAudioMapping = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const familyProfiles = {
    "Electronic / Club": { regularity: 0.92, turbulence: 0.18, contour: 0.78, haze: 0.1, heat: 0.18 },
    "Electronic / Experimental": { regularity: 0.28, turbulence: 0.82, contour: 0.9, haze: 0.28, heat: 0.05 },
    "Ambient / Cinematic": { regularity: 0.2, turbulence: 0.16, contour: 0.55, haze: 0.9, heat: -0.12 },
    "Rock / Metal": { regularity: 0.55, turbulence: 0.66, contour: 0.82, haze: 0.2, heat: 0.2 },
    "Hip-Hop / Rap": { regularity: 0.68, turbulence: 0.38, contour: 0.72, haze: 0.22, heat: 0.14 },
    "Jazz / Soul": { regularity: 0.34, turbulence: 0.24, contour: 0.62, haze: 0.5, heat: 0.18 },
    "Acoustic / Traditional": { regularity: 0.3, turbulence: 0.18, contour: 0.58, haze: 0.42, heat: 0.12 },
    "Latin / Brazilian": { regularity: 0.72, turbulence: 0.42, contour: 0.76, haze: 0.14, heat: 0.3 },
    "Pop / Internet": { regularity: 0.6, turbulence: 0.4, contour: 0.7, haze: 0.32, heat: 0.2 },
    Unknown: { regularity: 0.42, turbulence: 0.34, contour: 0.64, haze: 0.38, heat: 0 }
  };

  function target(input = {}) {
    const state = input.state || {};
    const audio = state.audio || {};
    const mood = state.mood?.fused || {};
    const character = state.trackCharacter || {};
    const rhythmicComplexity = clamp(character.rhythm?.rhythmicComplexity);
    const breakbeat = clamp(character.rhythm?.breakbeatLikelihood);
    const roughness = clamp(character.timbre?.roughness);
    const granularness = clamp(character.texture?.granularness);
    const layeredness = clamp(character.texture?.layeredness);
    const compression = clamp(character.dynamics?.compressionDensity);
    const depth = clamp(character.space?.perceivedDepth);
    const style = familyProfiles[state.genre?.family] || familyProfiles.Unknown;
    const bass = clamp(input.bass ?? audio.bass);
    const mid = clamp(input.mid ?? audio.mid);
    const high = clamp(input.high ?? audio.high);
    const energy = clamp(input.energy ?? audio.energy);
    const beat = clamp(input.beat);
    const novelty = clamp(state.novelty?.score);
    const arousal = clamp(mood.arousal ?? 0.45);
    const tension = clamp(mood.tension ?? 0.35);
    const warmth = clamp(mood.warmth ?? 0.5);
    const brightness = clamp(mood.brightness ?? 0.5);
    const spaciousness = clamp(mood.spaciousness ?? 0.5);
    return {
      bass,
      mid,
      high,
      energy,
      beat,
      impact: beat,
      novelty,
      deformation: clamp(0.16 + bass * 0.58 + beat * 0.28),
      turbulence: clamp(0.06 + novelty * 0.5 + tension * 0.12 + style.turbulence * 0.18 + roughness * 0.1 + rhythmicComplexity * 0.12),
      contour: clamp(0.32 + mid * 0.25 + style.contour * 0.27 + novelty * 0.09 + layeredness * 0.09),
      shimmer: clamp(0.1 + high * 0.62 + brightness * 0.13 + granularness * 0.15),
      heat: clamp(0.38 + warmth * 0.3 + arousal * 0.12 + compression * 0.08 + style.heat),
      haze: clamp(0.06 + spaciousness * 0.38 + depth * 0.18 + style.haze * 0.32),
      regularity: clamp(style.regularity * (0.62 + (state.audio?.beatConfidence || 0) * 0.38) * (1 - breakbeat * 0.28)),
      motion: clamp(0.1 + arousal * 0.32 + energy * 0.23 + novelty * 0.18 + rhythmicComplexity * 0.12 + breakbeat * 0.05)
    };
  }

  class Mapper {
    constructor() {
      this.values = target();
    }

    update(input, deltaMs = 16.67) {
      const next = target(input);
      for (const key of Object.keys(next)) {
        const risingImpact = key === "impact" && next[key] > this.values[key];
        const timeConstant = key === "impact" ? (risingImpact ? 28 : 520) : key === "deformation" ? 110 : 240;
        const response = 1 - Math.exp(-Math.max(1, deltaMs) / timeConstant);
        this.values[key] += (next[key] - this.values[key]) * response;
      }
      return this.values;
    }
  }

  return { Mapper, target, familyProfiles, clamp };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BackgroundAudioMapping;
