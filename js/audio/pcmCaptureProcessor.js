class MusicShowerPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const requested = Number(options.processorOptions?.blockSize) || 4096;
    this.blockSize = Math.max(1024, Math.min(8192, Math.round(requested)));
    this.block = new Float32Array(this.blockSize);
    this.offset = 0;
    const shared = options.processorOptions?.sharedRing;
    this.sharedHeader = shared?.headerBuffer ? new Int32Array(shared.headerBuffer) : null;
    this.sharedData = shared?.dataBuffer ? new Float32Array(shared.dataBuffer) : null;
    this.sharedCapacity = Math.min(Number(shared?.capacity) || 0, this.sharedData?.length || 0);
    this.energySum = 0;
    this.peak = 0;
    this.processingMs = 0;
    this.low250 = 0;
    this.low4000 = 0;
    this.lowAlpha = 1 - Math.exp(-2 * Math.PI * 250 / sampleRate);
    this.highAlpha = 1 - Math.exp(-2 * Math.PI * 4000 / sampleRate);
    this.bandSquares = { bass: 0, mid: 0, high: 0 };
    this.stereo = { channels: 0, lrSum: 0, lSq: 0, rSq: 0, samples: 0 };
  }

  flush() {
    const completed = this.block;
    this.block = new Float32Array(this.blockSize);
    this.offset = 0;
    const rms = Math.sqrt(this.energySum / Math.max(1, completed.length));
    const bands = Object.fromEntries(Object.entries(this.bandSquares).map(([key, value]) =>
      [key, Math.sqrt(value / Math.max(1, completed.length))]));
    const stereo = this.stereoSnapshot();
    if (this.sharedHeader && this.sharedData && this.sharedCapacity) {
      Atomics.add(this.sharedHeader, 2, 1);
      let writeIndex = Atomics.load(this.sharedHeader, 0);
      for (let index = 0; index < completed.length; index++) {
        this.sharedData[writeIndex] = completed[index];
        writeIndex = (writeIndex + 1) % this.sharedCapacity;
      }
      Atomics.store(this.sharedHeader, 0, writeIndex);
      Atomics.store(this.sharedHeader, 1, Math.min(this.sharedCapacity,
        Atomics.load(this.sharedHeader, 1) + completed.length));
      Atomics.add(this.sharedHeader, 3, completed.length);
      Atomics.add(this.sharedHeader, 2, 1);
      this.port.postMessage({ type: "metrics", blockSize: this.blockSize, rms, peak: this.peak, bands, processingMs: this.processingMs, stereo });
    } else {
      this.port.postMessage({ type: "pcm", samples: completed, blockSize: this.blockSize, rms, peak: this.peak, bands, processingMs: this.processingMs, stereo }, [completed.buffer]);
    }
    this.energySum = 0;
    this.peak = 0;
    this.processingMs = 0;
    this.bandSquares = { bass: 0, mid: 0, high: 0 };
    this.stereo = { channels: 0, lrSum: 0, lSq: 0, rSq: 0, samples: 0 };
  }

  stereoSnapshot() {
    if (this.stereo.channels < 2 || this.stereo.samples < 32) {
      return { available: false, reason: "mono_input", channels: this.stereo.channels || 1 };
    }
    const denom = Math.sqrt(this.stereo.lSq * this.stereo.rSq);
    const correlation = denom > 1e-12 ? this.stereo.lrSum / denom : 1;
    const mid = (this.stereo.lSq + this.stereo.rSq) * 0.5 + this.stereo.lrSum;
    const side = (this.stereo.lSq + this.stereo.rSq) * 0.5 - this.stereo.lrSum;
    const sideRatio = (mid + side) > 1e-12 ? Math.max(0, side) / (Math.abs(mid) + Math.abs(side)) : 0;
    return { available: true, channels: this.stereo.channels, correlation, sideRatio, samples: this.stereo.samples };
  }

  process(inputs, outputs) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const input = inputs[0];
    if (input?.length) {
      const length = input[0]?.length || 0;
      this.stereo.channels = Math.max(this.stereo.channels, input.length);
      for (let index = 0; index < length; index++) {
        let mono = 0;
        for (let channel = 0; channel < input.length; channel++) {
          mono += input[channel][index] || 0;
        }
        if (input.length >= 2) {
          const left = input[0][index] || 0;
          const right = input[1][index] || 0;
          this.stereo.lrSum += left * right;
          this.stereo.lSq += left * left;
          this.stereo.rSq += right * right;
          this.stereo.samples += 1;
        }
        const sample = mono / input.length;
        this.block[this.offset++] = sample;
        this.energySum += sample * sample;
        this.peak = Math.max(this.peak, Math.abs(sample));
        this.low250 += this.lowAlpha * (sample - this.low250);
        this.low4000 += this.highAlpha * (sample - this.low4000);
        const bass = this.low250, mid = this.low4000 - this.low250, high = sample - this.low4000;
        this.bandSquares.bass += bass * bass;
        this.bandSquares.mid += mid * mid;
        this.bandSquares.high += high * high;
        if (this.offset >= this.blockSize) this.flush();
      }
    }
    if (startedAt) this.processingMs += performance.now() - startedAt;
    return true;
  }
}

registerProcessor("music-shower-pcm-capture", MusicShowerPcmCaptureProcessor);
