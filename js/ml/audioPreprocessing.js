class AudioWindowBuffer {
  constructor(sampleRate, seconds = 30) {
    this.sampleRate = Math.max(8000, Number(sampleRate) || 48000);
    this.capacity = Math.max(1, Math.floor(this.sampleRate * seconds));
    this.buffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.count = 0;
  }

  push(frame) {
    if (!frame?.length) return;
    const source = frame.length > this.capacity ? frame.subarray(frame.length - this.capacity) : frame;
    const firstLength = Math.min(source.length, this.capacity - this.writeIndex);
    this.buffer.set(source.subarray(0, firstLength), this.writeIndex);
    const remaining = source.length - firstLength;
    if (remaining > 0) this.buffer.set(source.subarray(firstLength), 0);
    this.writeIndex = (this.writeIndex + source.length) % this.capacity;
    this.count = Math.min(this.capacity, this.count + source.length);
  }

  clear() {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.count = 0;
  }

  latest(seconds, targetRate = this.sampleRate, { normalize = false } = {}) {
    const source = this.latestNative(seconds);
    if (!source.length) return source;
    const resampled = targetRate === this.sampleRate
      ? source
      : AudioWindowBuffer.resampleWindowedSinc(source, this.sampleRate, targetRate);
    return normalize ? AudioWindowBuffer.normalize(resampled) : resampled;
  }

  latestNative(seconds) {
    const sourceLength = Math.min(this.count, Math.floor(this.sampleRate * seconds));
    if (!sourceLength) return new Float32Array();
    const source = new Float32Array(sourceLength);
    const start = (this.writeIndex - sourceLength + this.capacity) % this.capacity;
    const firstLength = Math.min(sourceLength, this.capacity - start);
    source.set(this.buffer.subarray(start, start + firstLength), 0);
    if (firstLength < sourceLength) source.set(this.buffer.subarray(0, sourceLength - firstLength), firstLength);
    return source;
  }

  static resampleWindowedSinc(source, sourceRate, targetRate, halfTaps = 16) {
    if (!source?.length || !sourceRate || !targetRate) return new Float32Array();
    if (sourceRate === targetRate) return new Float32Array(source);
    const outputLength = Math.max(1, Math.round(source.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / targetRate;
    const cutoff = Math.min(1, targetRate / sourceRate) * 0.94;
    for (let index = 0; index < outputLength; index++) {
      const position = index * ratio;
      const center = Math.floor(position);
      let weighted = 0;
      let weightSum = 0;
      for (let tap = -halfTaps + 1; tap <= halfTaps; tap++) {
        const sourceIndex = center + tap;
        if (sourceIndex < 0 || sourceIndex >= source.length) continue;
        const distance = position - sourceIndex;
        const x = Math.PI * distance * cutoff;
        const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x;
        const windowPosition = Math.abs(distance) / halfTaps;
        if (windowPosition >= 1) continue;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * windowPosition);
        const weight = sinc * window * cutoff;
        weighted += source[sourceIndex] * weight;
        weightSum += weight;
      }
      output[index] = weightSum ? weighted / weightSum : 0;
    }
    return output;
  }

  static resampleLinear(source, sourceRate, targetRate) {
    if (!source?.length || !sourceRate || !targetRate) return new Float32Array();
    const outputLength = Math.max(1, Math.round(source.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < outputLength; index++) {
      const position = index * ratio;
      const lower = Math.min(source.length - 1, Math.floor(position));
      const upper = Math.min(source.length - 1, lower + 1);
      const mix = position - lower;
      output[index] = source[lower] * (1 - mix) + source[upper] * mix;
    }
    return output;
  }

  static normalize(source) {
    if (!source?.length) return new Float32Array();
    let peak = 0;
    let mean = 0;
    for (const value of source) mean += value;
    mean /= source.length;
    for (const value of source) peak = Math.max(peak, Math.abs(value - mean));
    const scale = peak > 0.00001 ? Math.min(8, 0.95 / peak) : 1;
    const output = new Float32Array(source.length);
    for (let index = 0; index < source.length; index++) output[index] = (source[index] - mean) * scale;
    return output;
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = AudioWindowBuffer;
