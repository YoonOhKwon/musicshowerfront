// Tracks the dominant bass-register frequency bin over time so a bassline's note-to-note
// movement (walking bass) can be distinguished from a static, repeated note or unpitched noise.
// This is a coarse bin-index proxy, not a calibrated pitch/note estimate.
const BassPitchTracker = (() => {
  const RingBufferRef = typeof RingBuffer !== "undefined" ? RingBuffer : require("../core/ringBuffer");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  class Tracker {
    constructor({ capacity = 240, range = [41, 250] } = {}) {
      this.capacity = capacity;
      this.range = range;
      this.reset();
    }

    reset() {
      this.history = new RingBufferRef(this.capacity);
    }

    observeFrame(frequencyData, sampleRate, fftSize, at = Date.now()) {
      if (!frequencyData?.length || !sampleRate || !fftSize) return;
      const hzPerBin = sampleRate / fftSize;
      const startBin = Math.max(1, Math.floor(this.range[0] / hzPerBin));
      const endBin = Math.min(frequencyData.length, Math.ceil(this.range[1] / hzPerBin));
      if (endBin <= startBin) return;
      let peakBin = -1, peakValue = -Infinity, sum = 0, count = 0;
      for (let index = startBin; index < endBin; index++) {
        const value = frequencyData[index];
        sum += value; count++;
        if (value > peakValue) { peakValue = value; peakBin = index; }
      }
      if (peakBin < 0 || count === 0) return;
      const mean = sum / count;
      // A broad, noisy bass band has its peak close to the band average; a resonant note stands out.
      const clarity = clamp((peakValue - mean) / 255);
      this.history.push({ at, bin: peakBin, clarity });
    }

    // onsetTimestamps: ms timestamps of onsets already qualified as bass-register hits
    // (e.g. beatDetector's onsetEvents filtered by lowImpact) — this tracker does not detect onsets itself.
    profile(onsetTimestamps = [], toleranceMs = 60) {
      const frames = this.history.values();
      const empty = { bassPitchMotion: null, bassOnsetRegularity: null, bassRepetition: null, sampleCount: 0 };
      if (frames.length < 8 || onsetTimestamps.length < 8) return empty;
      const samples = [];
      for (const at of onsetTimestamps) {
        let nearest = null, nearestDelta = Infinity;
        for (const frame of frames) {
          const delta = Math.abs(frame.at - at);
          if (delta < nearestDelta) { nearestDelta = delta; nearest = frame; }
        }
        if (nearest && nearestDelta <= toleranceMs) samples.push({ at, bin: nearest.bin, clarity: nearest.clarity });
      }
      if (samples.length < 6) return { ...empty, sampleCount: samples.length };
      samples.sort((a, b) => a.at - b.at);
      const avgClarity = samples.reduce((sum, item) => sum + item.clarity, 0) / samples.length;
      // Without a reasonably clear bass fundamental, note-to-note movement cannot be claimed.
      if (avgClarity < 0.12) return { ...empty, sampleCount: samples.length };
      const binDeltas = samples.slice(1).map((item, index) => Math.abs(item.bin - samples[index].bin));
      const meanDelta = binDeltas.reduce((sum, value) => sum + value, 0) / binDeltas.length;
      const bassPitchMotion = clamp(clamp(meanDelta / 6) * clamp(avgClarity * 2));
      const intervals = samples.slice(1).map((item, index) => item.at - samples[index].at);
      const center = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
      const variability = center > 0
        ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - center) ** 2, 0) / intervals.length) / center
        : 1;
      const bassOnsetRegularity = clamp(1 - variability * 1.6);
      // A genuine ostinato/riff repeats the same short bin sequence: autocorrelate the bin
      // series at a handful of short lags (2..6 notes) and keep the strongest match — high
      // similarity at a short, consistent lag is real repetition, not just note-to-note motion.
      let bassRepetition = null;
      if (samples.length >= 10) {
        const bins = samples.map(item => item.bin);
        const span = Math.max(1, Math.max(...bins) - Math.min(...bins));
        let best = 0;
        for (let lag = 2; lag <= Math.min(6, Math.floor(bins.length / 2)); lag++) {
          const diffs = [];
          for (let index = lag; index < bins.length; index++) diffs.push(Math.abs(bins[index] - bins[index - lag]) / span);
          const similarity = 1 - (diffs.reduce((sum, value) => sum + value, 0) / diffs.length);
          if (similarity > best) best = similarity;
        }
        bassRepetition = clamp(best);
      }
      return { bassPitchMotion, bassOnsetRegularity, bassRepetition, sampleCount: samples.length };
    }
  }

  return { Tracker };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BassPitchTracker;
