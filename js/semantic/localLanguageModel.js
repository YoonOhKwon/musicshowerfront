const LocalLanguageModel = (() => {
  class Adapter {
    constructor(config = {}) {
      this.config = config;
      this.state = { status: config.enabled ? "unavailable" : "disabled", model: null, latencyMs: 0, error: null };
      this.generator = null;
    }

    async initialize() {
      if (!this.config.enabled) return this.state;
      const factory = globalThis.musicShowerLocalLanguageAdapter;
      if (typeof factory !== "function") {
        this.state = { ...this.state, status: "unavailable", error: "localLanguageModelNotInstalled" };
        return this.state;
      }
      try {
        this.state = { ...this.state, status: "loading", error: null };
        this.generator = await factory(this.config);
        this.state = { ...this.state, status: "ready", model: this.generator?.name || "local-adapter" };
      } catch (error) {
        this.state = { ...this.state, status: "unavailable", error: error.message || "localLanguageLoadFailed" };
      }
      return this.state;
    }

    async generate(seed, count = 48) {
      if (this.state.status !== "ready" || !this.generator?.generate) return [];
      const startedAt = performance.now();
      try {
        const result = await this.generator.generate(seed, count);
        this.state.latencyMs = performance.now() - startedAt;
        return Array.isArray(result) ? result : [];
      } catch (error) {
        this.state = { ...this.state, status: "unavailable", error: error.message || "localLanguageGenerationFailed" };
        return [];
      }
    }
  }

  return { Adapter };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LocalLanguageModel;
