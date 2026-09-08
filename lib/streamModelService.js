"use strict";
const { Worker } = require("node:worker_threads");
const path = require("node:path");

class StreamModelService {
  constructor() { this.worker = null; this.pending = new Map(); this.sequence = 0; }
  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, "streamModelWorker.js"));
    this.worker = worker;
    worker.on("message", ({ id, result, error }) => {
      const task = this.pending.get(id);
      if (!task) return;
      this.pending.delete(id);
      task.cleanup();
      if (error) task.reject(new Error(error)); else task.resolve(result);
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", error => this.fail(worker, error));
    worker.on("exit", code => this.fail(worker, new Error(`Model worker exited (${code})`)));
    worker.unref();
    return worker;
  }
  fail(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const task of this.pending.values()) { task.cleanup(); task.reject(error); }
    this.pending.clear();
    worker.terminate().catch(() => {});
  }
  infer({ samples, sampleRate, signal }) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= 16) return Promise.reject(new Error("Model worker busy"));
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => {
        const task = this.pending.get(id);
        if (!task) return;
        this.pending.delete(id); task.cleanup(); reject(signal.reason);
        if (!this.pending.size) worker.unref();
      };
      const timeout = setTimeout(() => this.fail(worker, new Error("Model worker timeout")), 60000);
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      worker.ref();
      // Transfer a dedicated copy so the session's rolling audio stays intact.
      const copy = Float32Array.from(samples);
      worker.postMessage({ id, samples: copy, sampleRate }, [copy.buffer]);
    });
  }
  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    this.fail(worker, new Error("Model service closed"));
    await worker.terminate();
  }
}

const service = new StreamModelService();
module.exports = { StreamModelService, inferStreamModels: task => service.infer(task) };
