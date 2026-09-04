class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this.buffer = new Array(this.capacity);
    this.start = 0;
    this.count = 0;
    this.version = 0;
  }

  get length() {
    return this.count;
  }

  push(value) {
    const target = (this.start + this.count) % this.capacity;
    this.buffer[target] = value;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
    this.version += 1;
    return this.count;
  }

  latest() {
    if (!this.count) return undefined;
    return this.buffer[(this.start + this.count - 1) % this.capacity];
  }

  values() {
    const result = new Array(this.count);
    for (let index = 0; index < this.count; index++) {
      result[index] = this.buffer[(this.start + index) % this.capacity];
    }
    return result;
  }

  clear() {
    this.buffer.fill(undefined);
    this.start = 0;
    this.count = 0;
    this.version += 1;
  }

  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]();
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = RingBuffer;
