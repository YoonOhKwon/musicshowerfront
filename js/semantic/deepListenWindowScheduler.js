// Bounded Deep Listen window scheduler: cadence is independent of GPU inference duration.
// One in-flight upload plus a small pending queue preserves unheard sections without backlog.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DeepListenWindowScheduler = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  class Scheduler {
    constructor(options = {}) {
      this.firstCaptureSeconds = Number(options.firstCaptureSeconds) || 12;
      this.recaptureIntervalSeconds = Number(options.recaptureIntervalSeconds) || 45;
      this.maxPending = Math.max(1, Math.min(4, Number(options.maxPending) || 1));
      this.requestGeneration = 0;
      this.reset(options.trackEpoch || 1);
    }

    reset(trackEpoch = 1) {
      this.trackEpoch = Number(trackEpoch) || 1;
      this.active = false;
      this.lastTriggeredAt = 0;
      this.pending = [];
      this.requestSequence = 0;
      this.requestGeneration += 1;
    }

    cadenceDueAtMs() {
      return this.lastTriggeredAt
        ? this.lastTriggeredAt + this.recaptureIntervalSeconds * 1000
        : this.firstCaptureSeconds * 1000;
    }

    isFirstImpression() {
      return !this.lastTriggeredAt;
    }

    due(activeListeningMs) {
      return Number(activeListeningMs) > this.cadenceDueAtMs();
    }

    markTriggered(activeListeningMs) {
      this.lastTriggeredAt = Number(activeListeningMs) || 0;
    }

    beginUpload() {
      this.active = true;
      this.requestSequence += 1;
      return this.requestSequence;
    }

    endUpload() {
      this.active = false;
    }

    enqueuePending(capture) {
      if (!capture || this.isStale(capture)) return false;
      while (this.pending.length >= this.maxPending) this.pending.shift();
      this.pending.push(capture);
      return true;
    }

    takePending() {
      while (this.pending.length) {
        const next = this.pending.shift();
        if (!this.isStale(next)) return next;
      }
      return null;
    }

    isStale(capture) {
      if (!capture || typeof capture !== "object") return true;
      if (Number(capture.trackEpoch) !== Number(this.trackEpoch)) return true;
      if (capture.requestGeneration !== undefined &&
          Number(capture.requestGeneration) !== Number(this.requestGeneration)) return true;
      return false;
    }

    inspect() {
      return {
        trackEpoch: this.trackEpoch,
        uploadInFlight: this.active,
        pendingCount: this.pending.length,
        pendingWindow: this.pending.length > 0,
        cadenceDueAtMs: this.cadenceDueAtMs(),
        requestSequence: this.requestSequence,
        lastTriggeredAtMs: this.lastTriggeredAt,
        requestGeneration: this.requestGeneration
      };
    }
  }

  return { Scheduler };
});
