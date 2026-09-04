const ZeroShotGenre = (() => {
  const cosine = (left = [], right = []) => {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < length; index++) {
      const a = Number(left[index]) || 0;
      const b = Number(right[index]) || 0;
      dot += a * b;
      leftNorm += a * a;
      rightNorm += b * b;
    }
    return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
  };

  class Classifier {
    constructor(database = {}) {
      const legacyEntries = Array.isArray(database) ? database : database.entries || [];
      this.model = Array.isArray(database) ? "legacy" : database.model;
      this.audioEncoder = Array.isArray(database) ? null : database.audioEncoder;
      this.dimension = Number(Array.isArray(database) ? legacyEntries[0]?.embedding?.length : database.dimension) || 0;
      this.enabled = Array.isArray(database) ? true : database.available === true;
      this.entries = legacyEntries.filter(item =>
        item?.label && item.embedding?.length && (!this.dimension || item.embedding.length === this.dimension)
      );
    }

    get available() {
      return this.enabled && Boolean(this.model) && this.dimension > 0 && this.entries.length > 0;
    }

    classify(audioEmbedding, limit = 5) {
      if (!this.available || audioEmbedding?.length !== this.dimension) return [];
      return this.entries.map(item => ({
        label: item.label,
        confidence: Math.max(0, cosine(audioEmbedding, item.embedding)),
        family: item.family || "Unknown"
      })).sort((left, right) => right.confidence - left.confidence).slice(0, limit);
    }

    status() {
      return {
        available: this.available,
        model: this.model || null,
        audioEncoder: this.audioEncoder || null,
        dimension: this.dimension,
        labels: this.entries.length
      };
    }
  }

  return { Classifier, cosine };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZeroShotGenre;
