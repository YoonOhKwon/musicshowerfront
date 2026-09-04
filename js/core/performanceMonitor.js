const RuntimePerformance = (() => {
  const limit = 120;
  const samples = { longTasks: [], background: [], worker: [], audioWorklet: [], mir: [], semantic: [] };
  let observer = null;

  const push = (list, value) => {
    if (!Number.isFinite(Number(value))) return;
    list.push(Number(value));
    if (list.length > limit) list.splice(0, list.length - limit);
  };
  const mean = list => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
  const percentile = (list, ratio) => {
    if (!list.length) return 0;
    const sorted = list.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  };

  function start() {
    if (observer || typeof PerformanceObserver === "undefined") return;
    try {
      observer = new PerformanceObserver(entries => {
        for (const entry of entries.getEntries()) push(samples.longTasks, entry.duration);
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch (_) {
      observer = null;
    }
  }

  function reset() {
    for (const values of Object.values(samples)) values.length = 0;
  }

  function snapshot() {
    return {
      longTaskMeanMs: mean(samples.longTasks),
      longTaskP90Ms: percentile(samples.longTasks, 0.9),
      longTaskCount: samples.longTasks.length,
      backgroundMeanMs: mean(samples.background),
      backgroundP90Ms: percentile(samples.background, 0.9),
      workerMeanMs: mean(samples.worker),
      workerP90Ms: percentile(samples.worker, 0.9),
      audioWorkletMeanMs: mean(samples.audioWorklet),
      audioWorkletP90Ms: percentile(samples.audioWorklet, 0.9),
      mirMeanMs: mean(samples.mir),
      mirP90Ms: percentile(samples.mir, 0.9),
      semanticMeanMs: mean(samples.semantic),
      semanticP90Ms: percentile(samples.semantic, 0.9),
      memoryMB: typeof performance !== "undefined" && performance.memory
        ? performance.memory.usedJSHeapSize / (1024 * 1024) : null
    };
  }

  return {
    start,
    reset,
    snapshot,
    recordBackground: value => push(samples.background, value),
    recordWorker: value => push(samples.worker, value),
    recordAudioWorklet: value => push(samples.audioWorklet, value),
    recordMIR: value => push(samples.mir, value),
    recordSemantic: value => push(samples.semantic, value)
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = RuntimePerformance;
