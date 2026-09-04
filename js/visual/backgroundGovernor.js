const BackgroundPerformance = (() => {
  const profiles = {
    high: { scale: 0.8, frameStride: 1, mlMultiplier: 1, languageMultiplier: 1, zeroShotAllowed: true },
    medium: { scale: 0.64, frameStride: 1, mlMultiplier: 1.35, languageMultiplier: 1.65, zeroShotAllowed: false },
    low: { scale: 0.5, frameStride: 2, mlMultiplier: 1.9, languageMultiplier: 2.5, zeroShotAllowed: false }
  };

  class Governor {
    constructor(initial = "high") {
      this.level = profiles[initial] ? initial : "high";
      this.lowFrames = 0;
      this.strongFrames = 0;
    }

    observe({ fps = 60, inferenceLatency = 0, longTaskMs = 0, backgroundMs = 0 } = {}) {
      const stressed = fps > 0 && fps < 43 || inferenceLatency > 850 || longTaskMs > 70 || backgroundMs > 14;
      const strong = fps >= 56 && (!inferenceLatency || inferenceLatency < 420) && longTaskMs < 45 && backgroundMs < 9;
      this.lowFrames = stressed ? this.lowFrames + 1 : Math.max(0, this.lowFrames - 2);
      this.strongFrames = strong ? this.strongFrames + 1 : 0;
      if (this.lowFrames >= 90) {
        this.level = this.level === "high" ? "medium" : "low";
        this.lowFrames = 0;
        this.strongFrames = 0;
      } else if (this.strongFrames >= 420) {
        this.level = this.level === "low" ? "medium" : "high";
        this.strongFrames = 0;
      }
      return this.profile();
    }

    profile() {
      return { level: this.level, ...profiles[this.level] };
    }
  }

  return { Governor, profiles };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BackgroundPerformance;
