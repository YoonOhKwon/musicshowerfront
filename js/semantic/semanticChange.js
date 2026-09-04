const SemanticChange = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function cosineDistance(left = [], right = []) {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let index = 0; index < length; index++) {
      const x = Number(left[index]) || 0;
      const y = Number(right[index]) || 0;
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    return a && b ? clamp((1 - dot / Math.sqrt(a * b)) / 0.35) : 0;
  }

  function genreDistance(left = [], right = []) {
    const labels = new Set([...left, ...right].map(item => item.label));
    if (!labels.size) return 0;
    const a = new Map(left.map(item => [item.label, Number(item.confidence) || 0]));
    const b = new Map(right.map(item => [item.label, Number(item.confidence) || 0]));
    let distance = 0;
    for (const label of labels) distance += Math.abs((a.get(label) || 0) - (b.get(label) || 0));
    return clamp(distance / Math.max(0.18, labels.size * 0.12));
  }

  function vectorDistance(left = [], right = []) {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Math.abs((Number(left[index]) || 0) - (Number(right[index]) || 0));
    return clamp(sum / length / 0.28);
  }

  class Detector {
    constructor({ threshold = 0.36, cooldownMs = 1600 } = {}) {
      this.threshold = threshold;
      this.cooldownMs = cooldownMs;
      this.reset();
    }

    reset() {
      this.epoch = 0;
      this.previous = null;
      this.lastChangeAt = -Infinity;
    }

    advance(at = Date.now()) {
      this.epoch += 1;
      this.lastChangeAt = at;
      return this.epoch;
    }

    update(input = {}, at = Date.now()) {
      const current = {
        embedding: input.embedding || [],
        genre: input.genre || [],
        character: input.character?.fingerprint || input.character || []
      };
      if (!this.previous) {
        this.previous = current;
        return { score: 0, changed: false, epoch: this.epoch, components: {} };
      }
      const components = {
        embedding: cosineDistance(this.previous.embedding, current.embedding),
        genre: genreDistance(this.previous.genre, current.genre),
        character: vectorDistance(this.previous.character, current.character),
        novelty: clamp(input.novelty),
        section: input.sectionTransition ? 1 : 0
      };
      const score = clamp(
        components.embedding * 0.31 + components.genre * 0.23 + components.character * 0.25 +
        components.novelty * 0.13 + components.section * 0.08
      );
      const corroborated = [components.embedding, components.genre, components.character, components.section]
        .filter(value => value >= 0.3).length >= 2;
      const changed = score >= this.threshold && corroborated && at - this.lastChangeAt >= this.cooldownMs;
      if (changed) {
        this.epoch += 1;
        this.lastChangeAt = at;
        this.previous = current;
      } else {
        this.previous = {
          embedding: current.embedding.length ? current.embedding : this.previous.embedding,
          genre: current.genre.length ? current.genre : this.previous.genre,
          character: current.character.length ? current.character : this.previous.character
        };
      }
      return { score, changed, epoch: this.epoch, components };
    }
  }

  return { Detector, cosineDistance, genreDistance, vectorDistance };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SemanticChange;
