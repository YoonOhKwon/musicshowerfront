class MultiRateScheduler {
  constructor() {
    this.jobs = new Map();
  }

  add(name, intervalMs, callback, { immediate = true } = {}) {
    this.jobs.set(name, {
      intervalMs: Math.max(16, Number(intervalMs) || 1000),
      callback,
      lastRun: immediate ? -Infinity : performance.now(),
      running: false,
      pending: false
    });
  }

  setInterval(name, intervalMs) {
    const job = this.jobs.get(name);
    if (!job) return false;
    job.intervalMs = Math.max(16, Number(intervalMs) || job.intervalMs);
    return true;
  }

  tick(now = performance.now()) {
    for (const [name, job] of this.jobs) {
      if (now - job.lastRun < job.intervalMs) continue;
      if (job.running) {
        job.pending = true;
        continue;
      }
      this.run(name, job, now);
    }
  }

  run(name, job, now) {
    job.lastRun = now;
    try {
      const result = job.callback(now);
      if (!result || typeof result.then !== "function") return;
      job.running = true;
      result.catch(error => {
        if (typeof console !== "undefined") console.warn(`[scheduler:${name}]`, error);
      }).finally(() => {
        job.running = false;
        if (job.pending) {
          job.pending = false;
          this.run(name, job, performance.now());
        }
      });
    } catch (error) {
      if (typeof console !== "undefined") console.warn(`[scheduler:${name}]`, error);
    }
  }

  reset(now = performance.now()) {
    for (const job of this.jobs.values()) {
      job.lastRun = now - job.intervalMs;
      job.pending = false;
    }
  }

  clear() {
    this.jobs.clear();
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = MultiRateScheduler;
