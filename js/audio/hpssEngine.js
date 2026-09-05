// Harmonic/percussive spectrogram separation (Driedger-style median HPSS) on the existing 1D FFT
// magnitude. This is mix residual energy, not source-separated stems: it does not identify vocals,
// bass, or drums as tracks. Pitch trackers use the harmonic residual so a kick transient is less
// likely to steal the bass/melody peak; a percussive residual is kept only as a kick-rejection cue.
const Hpss = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function medianInPlace(buffer, length) {
    for (let index = 1; index < length; index++) {
      const key = buffer[index];
      let cursor = index - 1;
      while (cursor >= 0 && buffer[cursor] > key) {
        buffer[cursor + 1] = buffer[cursor];
        cursor -= 1;
      }
      buffer[cursor + 1] = key;
    }
    const middle = length >> 1;
    return length % 2 ? buffer[middle] : 0.5 * (buffer[middle - 1] + buffer[middle]);
  }

  function levelAt(spectrum, index) {
    const value = spectrum[index] || 0;
    return value > 1.5 ? value / 255 : value;
  }

  // Fold a magnitude spectrum onto 12 pitch classes (A4 = 440 Hz → MIDI 69). Used as an optional
  // harmonic chroma for key estimation; it is not a transcription.
  function chromaFromMagnitude(magnitude, sampleRate, fftSize, { minHz = 55, maxHz = 5000 } = {}) {
    const chroma = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (!magnitude?.length || !sampleRate || !fftSize) return chroma;
    const hzPerBin = sampleRate / fftSize;
    const start = Math.max(1, Math.floor(minHz / hzPerBin));
    const end = Math.min(magnitude.length, Math.ceil(maxHz / hzPerBin));
    for (let bin = start; bin < end; bin++) {
      const hz = bin * hzPerBin;
      const energy = magnitude[bin] || 0;
      if (!(hz > 0) || !(energy > 0)) continue;
      const pitchClass = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
      chroma[pitchClass] += energy;
    }
    const total = chroma.reduce((sum, value) => sum + value, 0);
    return total > 0 ? chroma.map(value => value / total) : chroma;
  }

  class Engine {
    constructor({ frames = 17, freqWidth = 9 } = {}) {
      this.frameCount = Math.max(5, frames | 0);
      this.freqWidth = Math.max(3, freqWidth | 0) | 1;
      this.history = [];
      this.timeScratch = new Float32Array(this.frameCount);
      this.freqScratch = new Float32Array(this.freqWidth);
      this.harmonic = null;
      this.percussive = null;
      this.chroma = null;
      this.harmonicRatio = 0;
      this.sampleRate = 0;
      this.fftSize = 0;
    }

    reset() {
      this.history = [];
      this.harmonic = null;
      this.percussive = null;
      this.chroma = null;
      this.harmonicRatio = 0;
    }

    observe(spectrum, { sampleRate = 0, fftSize = 0 } = {}) {
      if (!spectrum?.length) return this.snapshot();
      const size = spectrum.length;
      if (sampleRate) this.sampleRate = sampleRate;
      if (fftSize) this.fftSize = fftSize;
      const current = new Float32Array(size);
      for (let index = 0; index < size; index++) current[index] = levelAt(spectrum, index);
      this.history.push(current);
      if (this.history.length > this.frameCount) this.history.shift();

      const harmonicEst = new Float32Array(size);
      const percussiveEst = new Float32Array(size);
      const halfFreq = this.freqWidth >> 1;
      const available = this.history.length;
      for (let bin = 0; bin < size; bin++) {
        for (let frame = 0; frame < available; frame++) this.timeScratch[frame] = this.history[frame][bin];
        harmonicEst[bin] = medianInPlace(this.timeScratch, available);
        const start = Math.max(0, bin - halfFreq);
        const end = Math.min(size, bin + halfFreq + 1);
        const width = end - start;
        for (let index = 0; index < width; index++) this.freqScratch[index] = current[start + index];
        percussiveEst[bin] = medianInPlace(this.freqScratch, width);
      }

      if (!this.harmonic || this.harmonic.length !== size) {
        this.harmonic = new Float32Array(size);
        this.percussive = new Float32Array(size);
      }
      let harmonicEnergy = 0, percussiveEnergy = 0;
      for (let bin = 0; bin < size; bin++) {
        const harmonicPower = harmonicEst[bin] * harmonicEst[bin];
        const percussivePower = percussiveEst[bin] * percussiveEst[bin];
        const mix = current[bin];
        const power = harmonicPower + percussivePower;
        if (power < 1e-10) {
          // A spike that is an outlier in both time and frequency is still a transient, not a note.
          this.harmonic[bin] = 0;
          this.percussive[bin] = mix;
        } else {
          this.harmonic[bin] = mix * (harmonicPower / (power + 1e-8));
          this.percussive[bin] = mix * (percussivePower / (power + 1e-8));
        }
        harmonicEnergy += this.harmonic[bin];
        percussiveEnergy += this.percussive[bin];
      }
      this.harmonicRatio = clamp(harmonicEnergy / Math.max(1e-8, harmonicEnergy + percussiveEnergy));
      this.chroma = this.sampleRate && this.fftSize
        ? chromaFromMagnitude(this.harmonic, this.sampleRate, this.fftSize)
        : null;
      return this.snapshot();
    }

    snapshot() {
      return {
        harmonic: this.harmonic,
        percussive: this.percussive,
        chroma: this.chroma,
        harmonicRatio: this.harmonicRatio,
        ready: this.history.length >= 5,
        resolution: "harmonic/percussive mix residual; not source-separated stems"
      };
    }
  }

  return { Engine, chromaFromMagnitude };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Hpss;
