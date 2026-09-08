// AudibleAudioBuffer: accumulates only audibly-active PCM chunks so a Deep Listen capture
// window represents actual musical content, not wall-clock time. Silence during a pause is
// skipped entirely rather than occupying capture duration -- pushing nothing during silence is
// the whole mechanism, there is no separate "is this silent" check to get wrong here.
//
// wall clock:      AUDIO AUDIO AUDIO SILENCE SILENCE AUDIO AUDIO
// audible buffer:  AUDIO AUDIO AUDIO AUDIO AUDIO
//
// A genuinely new track must still reset() this buffer -- the old and new song must never mix.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AudibleAudioBuffer = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  class AudibleAudioBuffer {
    constructor(sampleRate, maxSeconds = 30) {
      this.sampleRate = Math.max(1, Number(sampleRate) || 48000);
      this.capacity = Math.max(1, Math.round(this.sampleRate * maxSeconds));
      this.data = new Float32Array(this.capacity);
      this.filled = 0;
      this.writeIndex = 0;
    }

    // Appends one chunk of audibly-active PCM. Call this only for chunks captured while audio
    // is actually sounding -- the caller (not this class) decides what counts as audible.
    push(chunk) {
      if (!chunk || !chunk.length) return;
      // Fixed ring writes are O(new samples). The previous sliding-array implementation moved
      // almost the entire 30-second buffer on every animation frame after it filled, creating
      // sustained main-thread memory bandwidth and garbage-collection pressure during long songs.
      const source = chunk.length > this.capacity
        ? chunk.subarray(chunk.length - this.capacity)
        : chunk;
      const firstLength = Math.min(source.length, this.capacity - this.writeIndex);
      this.data.set(source.subarray(0, firstLength), this.writeIndex);
      const remaining = source.length - firstLength;
      if (remaining > 0) this.data.set(source.subarray(firstLength), 0);
      this.writeIndex = (this.writeIndex + source.length) % this.capacity;
      this.filled = Math.min(this.capacity, this.filled + source.length);
    }

    seconds() {
      return this.filled / this.sampleRate;
    }

    // A copy of the accumulated audible-only samples, oldest first.
    snapshot() {
      if (!this.filled) return new Float32Array();
      const output = new Float32Array(this.filled);
      const start = (this.writeIndex - this.filled + this.capacity) % this.capacity;
      const firstLength = Math.min(this.filled, this.capacity - start);
      output.set(this.data.subarray(start, start + firstLength));
      if (firstLength < this.filled) output.set(this.data.subarray(0, this.filled - firstLength), firstLength);
      return output;
    }

    reset() {
      this.filled = 0;
      this.writeIndex = 0;
    }
  }

  return { AudibleAudioBuffer };
});
