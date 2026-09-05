// Tracks the dominant bass-register partial over time so a bassline's note-to-note movement
// (walking bass) can be distinguished from a static repeated note, a leaping riff, or unpitched
// noise. Peak-picks the harmonic residual when HPSS has one, then interpolates to a frequency and
// a continuous semitone — still a mix-level proxy, not transcription or a bass stem.
const BassPitchTracker = (() => {
  const RingBufferRef = typeof RingBuffer !== "undefined" ? RingBuffer : require("../core/ringBuffer");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function asLevel(value, floatSpectrum) {
    if (!Number.isFinite(value)) return 0;
    return floatSpectrum ? value : value / 255;
  }

  function pitchClassOf(frequency) {
    if (!(frequency > 0)) return null;
    return ((Math.round(12 * Math.log2(frequency / 440) + 69) % 12) + 12) % 12;
  }

  function emptyProfile(sampleCount = 0) {
    return {
      bassPitchMotion: null, bassOnsetRegularity: null, bassRepetition: null, sampleCount,
      walkingEvidence: null, stepwiseRatio: null, meanStepSemitones: null,
      harmonicClarity: null, dominantPitchClass: null, pitchClassHistogram: null
    };
  }

  class Tracker {
    constructor({ capacity = 240, range = [41, 250] } = {}) {
      this.capacity = capacity;
      this.range = range;
      this.reset();
    }

    reset() {
      this.history = new RingBufferRef(this.capacity);
    }

    observeFrame(frequencyData, sampleRate, fftSize, at = Date.now(), options = {}) {
      if (!frequencyData?.length || !sampleRate || !fftSize) return;
      const harmonic = options.harmonic;
      const useHarmonic = harmonic && harmonic.length === frequencyData.length;
      const spectrum = useHarmonic ? harmonic : frequencyData;
      const floatSpectrum = useHarmonic || options.floatSpectrum === true;
      const hzPerBin = sampleRate / fftSize;
      const startBin = Math.max(1, Math.floor(this.range[0] / hzPerBin));
      const endBin = Math.min(spectrum.length, Math.ceil(this.range[1] / hzPerBin));
      if (endBin <= startBin + 1) return;
      let peakBin = -1, peakValue = -Infinity, sum = 0, count = 0;
      for (let index = startBin; index < endBin; index++) {
        const value = asLevel(spectrum[index], floatSpectrum);
        sum += value; count++;
        if (value > peakValue) { peakValue = value; peakBin = index; }
      }
      if (peakBin < 0 || count === 0) return;
      const percussive = options.percussive;
      if (useHarmonic && percussive?.length === harmonic.length) {
        const harmonicPeak = asLevel(harmonic[peakBin], true);
        const percussivePeak = asLevel(percussive[peakBin], true);
        // A peak that is still mostly percussive in the residual is a kick/click, not a bass note.
        if (percussivePeak > harmonicPeak * 1.35 && percussivePeak > 0.08) return;
      }
      const mean = sum / count;
      const clarity = clamp(peakValue - mean);
      let frequency = peakBin * hzPerBin;
      if (peakBin > startBin && peakBin < endBin - 1) {
        const left = asLevel(spectrum[peakBin - 1], floatSpectrum);
        const right = asLevel(spectrum[peakBin + 1], floatSpectrum);
        const denominator = left - 2 * peakValue + right;
        const offset = denominator !== 0 ? 0.5 * (left - right) / denominator : 0;
        frequency = (peakBin + Math.max(-0.5, Math.min(0.5, offset))) * hzPerBin;
      }
      if (!(frequency > 0)) return;
      const semitone = 12 * Math.log2(frequency / 55);
      this.history.push({
        at, bin: peakBin, clarity, frequency, semitone,
        pitchClass: pitchClassOf(frequency)
      });
    }

    // onsetTimestamps: ms timestamps of onsets already qualified as bass-register hits
    // (e.g. beatDetector's onsetEvents filtered by lowImpact) — this tracker does not detect onsets itself.
    profile(onsetTimestamps = [], toleranceMs = 60) {
      const frames = this.history.values();
      const empty = emptyProfile(0);
      if (frames.length < 8 || onsetTimestamps.length < 8) return empty;
      const samples = [];
      for (const at of onsetTimestamps) {
        let nearest = null, nearestDelta = Infinity;
        for (const frame of frames) {
          const delta = Math.abs(frame.at - at);
          if (delta < nearestDelta) { nearestDelta = delta; nearest = frame; }
        }
        if (nearest && nearestDelta <= toleranceMs) {
          samples.push({
            at, bin: nearest.bin, clarity: nearest.clarity,
            semitone: nearest.semitone, pitchClass: nearest.pitchClass
          });
        }
      }
      if (samples.length < 6) return emptyProfile(samples.length);
      samples.sort((a, b) => a.at - b.at);
      const avgClarity = samples.reduce((sum, item) => sum + item.clarity, 0) / samples.length;
      // Without a reasonably clear bass fundamental, note-to-note movement cannot be claimed.
      if (avgClarity < 0.12) return emptyProfile(samples.length);
      const binDeltas = samples.slice(1).map((item, index) => Math.abs(item.bin - samples[index].bin));
      const meanBinDelta = binDeltas.reduce((sum, value) => sum + value, 0) / Math.max(1, binDeltas.length);
      const stepSemitones = samples.slice(1).map((item, index) => Math.abs(item.semitone - samples[index].semitone));
      const meanStepSemitones = stepSemitones.length
        ? stepSemitones.reduce((sum, value) => sum + value, 0) / stepSemitones.length : 0;
      // Semitone motion: ~7 semitones (a fifth) saturates the scale. Bin motion is kept as a
      // fallback so older tests that only moved by bin index still read the same quantity.
      const semitoneMotion = clamp(clamp(meanStepSemitones / 7) * clamp(avgClarity * 2));
      const binMotion = clamp(clamp(meanBinDelta / 6) * clamp(avgClarity * 2));
      const bassPitchMotion = stepSemitones.length ? Math.max(semitoneMotion, binMotion * 0.35) : binMotion;
      const intervals = samples.slice(1).map((item, index) => item.at - samples[index].at);
      const center = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
      const variability = center > 0
        ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - center) ** 2, 0) / intervals.length) / center
        : 1;
      const bassOnsetRegularity = clamp(1 - variability * 1.6);
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
      const stepwise = stepSemitones.filter(value => value >= 0.55 && value <= 3.5);
      const stepwiseRatio = stepSemitones.length ? stepwise.length / stepSemitones.length : 0;
      const movingRatio = stepSemitones.length
        ? stepSemitones.filter(value => value >= 0.55).length / stepSemitones.length : 0;
      const motionSweet = clamp(1 - Math.abs(meanStepSemitones - 2) / 4);
      let walkingEvidence = null;
      if (stepSemitones.length >= 5 && stepwiseRatio >= 0.55 && movingRatio >= 0.5
        && meanStepSemitones >= 0.7 && meanStepSemitones <= 4.2 && bassOnsetRegularity >= 0.55) {
        walkingEvidence = clamp(stepwiseRatio * 0.5 + bassOnsetRegularity * 0.35 + motionSweet * 0.05
          + clamp(avgClarity * 2) * 0.1);
      } else if (stepSemitones.length >= 5) {
        walkingEvidence = clamp(stepwiseRatio * bassOnsetRegularity * 0.35);
      }
      const histogram = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (const sample of samples) {
        if (Number.isInteger(sample.pitchClass)) histogram[sample.pitchClass] += 1;
      }
      let dominantPitchClass = null, dominantCount = 0;
      for (let index = 0; index < 12; index++) {
        if (histogram[index] > dominantCount) { dominantCount = histogram[index]; dominantPitchClass = index; }
      }
      return {
        bassPitchMotion, bassOnsetRegularity, bassRepetition, sampleCount: samples.length,
        walkingEvidence, stepwiseRatio, meanStepSemitones,
        harmonicClarity: avgClarity, dominantPitchClass, pitchClassHistogram: histogram
      };
    }
  }

  return { Tracker };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BassPitchTracker;
