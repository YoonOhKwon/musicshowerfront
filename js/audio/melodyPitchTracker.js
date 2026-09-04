// Tracks the strongest partial in the melodic register over time so a melody's SHAPE can be read
// (section 5). This is a predominant-partial proxy, not transcription: with no source separation
// the strongest melodic-band peak is whichever voice is loudest at that instant, and octave errors
// are possible. Every sample therefore carries a clarity value, and the contour engine refuses to
// speak when clarity stays low.
//
// Deliberately mirrors bassPitchTracker's shape (observeFrame + profile) so the two pitch proxies
// stay comparable and share the same honesty contract.
const MelodyPitchTracker = (() => {
  const RingBufferRef = typeof RingBuffer !== "undefined" ? RingBuffer : require("../core/ringBuffer");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  class Tracker {
    // 180-1400 Hz covers sung and most lead-instrument fundamentals while staying above the
    // bass tracker's band, so the two do not fight over the same energy.
    constructor({ capacity = 420, range = [180, 1400] } = {}) {
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
      if (endBin <= startBin + 2) return;
      let peakBin = -1, peakValue = -Infinity, sum = 0, count = 0;
      for (let index = startBin; index < endBin; index++) {
        const value = frequencyData[index];
        sum += value; count++;
        if (value > peakValue) { peakValue = value; peakBin = index; }
      }
      if (peakBin <= startBin || peakBin >= endBin - 1 || count === 0) return;
      const average = sum / count;
      // A sung/played note is a peak that stands clear of its own band's average level; a noisy
      // or percussive frame has its maximum sitting near that average.
      const clarity = clamp((peakValue - average) / 255);
      // Parabolic interpolation across the peak's neighbours recovers sub-bin frequency, which
      // matters because one raw bin can be well over a semitone wide down here.
      const left = frequencyData[peakBin - 1], right = frequencyData[peakBin + 1];
      const denominator = left - 2 * peakValue + right;
      const offset = denominator !== 0 ? 0.5 * (left - right) / denominator : 0;
      const frequency = (peakBin + Math.max(-0.5, Math.min(0.5, offset))) * hzPerBin;
      if (!(frequency > 0)) return;
      // Continuous semitone scale (A1 = 55 Hz as origin). Absolute pitch is not claimed; only
      // differences between samples are ever used.
      const semitone = 12 * Math.log2(frequency / 55);
      this.history.push({ at, semitone, clarity, frequency });
    }

    // Raw trajectory, oldest first. The contour engine owns note segmentation so that logic stays
    // pure and testable without a Web Audio graph.
    trajectory(windowMs = 0, now = Date.now()) {
      const frames = this.history.values();
      if (!windowMs) return frames;
      return frames.filter(frame => now - frame.at <= windowMs);
    }
  }

  return { Tracker };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MelodyPitchTracker;
