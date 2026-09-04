const PhraseProviders = (() => {
  class RemoteGenerativeProvider {
    constructor({ endpoint = "/api/language-pool", timeoutMs = 135000, enabled = true } = {}) {
      this.endpoint = endpoint;
      this.timeoutMs = timeoutMs;
      this.enabled = enabled;
      this.state = { status: enabled ? "idle" : "disabled", model: null, error: null };
    }

    async generate(request) {
      if (!this.enabled) throw new Error("Remote language generation is disabled.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      this.state = { ...this.state, status: "generating", error: null };
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          this.state = { ...this.state, meta: payload.meta || null };
          // The server sends a non-sensitive code and a retryable flag (section 14). Throwing a
          // bare message threw both away, which is why an exhausted credit balance and a one-off
          // timeout used to be retried on exactly the same schedule.
          const error = new Error(payload.message || payload.error || `Language provider HTTP ${response.status}`);
          error.status = response.status;
          error.code = payload.code || payload.error || null;
          error.retryable = payload.retryable !== false;
          throw error;
        }
        if (!Array.isArray(payload.candidates)) throw new Error("Language provider returned no candidate array.");
        this.state = { status: "ready", model: payload.meta?.model || null, error: null, meta: payload.meta || null };
        return payload;
      } catch (error) {
        if (error.name === "AbortError") { error.code = "language_client_timeout"; error.retryable = true; }
        this.state = { ...this.state, status: error.name === "AbortError" ? "timeout" : "error",
          error: error.message, code: error.code || null, retryable: error.retryable !== false };
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  class StructuredFallbackProvider {
    generate({ seed, semanticTokens, count = 72, nonce = 0 }) {
      const fallback = typeof PhrasePool !== "undefined" ? PhrasePool : require("./phrasePoolEngine");
      return {
        artDirection: ["track-character fallback"],
        candidates: fallback.structuredCandidates(seed, semanticTokens, count, nonce)
      };
    }
  }

  class WorkerCritic {
    constructor({ workerUrl = "/js/semantic/languageWorker.js" } = {}) {
      this.workerUrl = workerUrl;
      this.worker = null;
      this.sequence = 0;
      this.jobs = new Map();
    }
    rank(candidates, options) {
      if (typeof Worker === "undefined") {
        const critic = typeof LanguageCritic !== "undefined" ? LanguageCritic : require("./languageCritic");
        return Promise.resolve(critic.rank(candidates, options));
      }
      if (!this.worker) {
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = event => {
          const job = this.jobs.get(event.data.id);
          if (!job) return;
          clearTimeout(job.timeout);
          this.jobs.delete(event.data.id);
          if (event.data.error) job.reject(new Error(event.data.error)); else job.resolve(event.data.result);
        };
        this.worker.onerror = () => this.fail("Language critic worker failed.");
      }
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => this.fail("Language critic worker timed out."), 8000);
        this.jobs.set(id, { resolve, reject, timeout });
        this.worker.postMessage({ id, candidates, options });
      });
    }
    fail(message) {
      this.worker?.terminate(); this.worker = null;
      for (const job of this.jobs.values()) { clearTimeout(job.timeout); job.reject(new Error(message)); }
      this.jobs.clear();
    }
  }

  return { RemoteGenerativeProvider, StructuredFallbackProvider, WorkerCritic };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PhraseProviders;
