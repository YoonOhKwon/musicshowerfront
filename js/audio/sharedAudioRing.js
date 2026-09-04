class SharedAudioRing {
  static WRITE_INDEX = 0;
  static SAMPLE_COUNT = 1;
  static SEQUENCE = 2;
  static TOTAL_LOW = 3;

  static supported() {
    return typeof SharedArrayBuffer !== "undefined" &&
      (typeof crossOriginIsolated === "undefined" || crossOriginIsolated === true);
  }

  static create(sampleRate, seconds) {
    if (!SharedAudioRing.supported()) return null;
    const capacity = Math.max(4096, Math.ceil(Number(sampleRate) * Number(seconds)));
    return new SharedAudioRing({
      headerBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
      dataBuffer: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity),
      capacity,
      sampleRate
    });
  }

  constructor({ headerBuffer, dataBuffer, capacity, sampleRate }) {
    this.headerBuffer = headerBuffer;
    this.dataBuffer = dataBuffer;
    this.capacity = Number(capacity) || Math.floor(dataBuffer.byteLength / 4);
    this.sampleRate = Number(sampleRate) || 48000;
    this.header = new Int32Array(headerBuffer);
    this.data = new Float32Array(dataBuffer);
    this.shared = true;
  }

  get count() {
    return Math.max(0, Math.min(this.capacity, Atomics.load(this.header, SharedAudioRing.SAMPLE_COUNT)));
  }

  descriptor() {
    return {
      headerBuffer: this.headerBuffer,
      dataBuffer: this.dataBuffer,
      capacity: this.capacity,
      sampleRate: this.sampleRate
    };
  }

  latestNative(seconds) {
    const requested = Math.min(this.capacity, Math.max(1, Math.round(Number(seconds) * this.sampleRate)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = Atomics.load(this.header, SharedAudioRing.SEQUENCE);
      if (before & 1) continue;
      const count = Math.min(requested, this.count);
      const writeIndex = Atomics.load(this.header, SharedAudioRing.WRITE_INDEX);
      const output = new Float32Array(count);
      const start = (writeIndex - count + this.capacity) % this.capacity;
      const first = Math.min(count, this.capacity - start);
      output.set(this.data.subarray(start, start + first));
      if (first < count) output.set(this.data.subarray(0, count - first), first);
      const after = Atomics.load(this.header, SharedAudioRing.SEQUENCE);
      if (before === after && !(after & 1)) return output;
    }
    return new Float32Array();
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = SharedAudioRing;
