// Grades how played-out an open-layer (mood/association) phrase reads, instead of vetoing it.
// safeText() used to hard-reject this whole vocabulary family everywhere; in the open layer that
// is now phraseSelection.js's job via clichePenalty, since a stock phrase used sparingly still
// reads as an impression -- the same one on repeat reads as a template. Recency is read from the
// SAME `recent` list every other penalty in phraseSelection.js already uses; no extra state here.
const ClicheScore = (() => {
  const CLICHE_PATTERNS = [
    /과열된|냉각된/i, /저중력|무중력/i, /분홍빛|보랏빛/i, /유리.*(?:기억|고독|슬픔)/i,
    /압축된 고독/i, /금속성 황홀|차가운 황홀/i, /purple memory|glass loneliness|heated tension|weightless sadness/i
  ];

  function baseScore(text) {
    return typeof text === "string" && CLICHE_PATTERNS.some(pattern => pattern.test(text)) ? 0.6 : 0;
  }

  // A literal repeat compounds hardest; other cliché-family phrases seen recently add a smaller
  // amount, so the open layer as a whole gets steered away from this register over time rather
  // than any single phrase being singled out.
  function score(text, recent = []) {
    const base = baseScore(text);
    const recentRepeat = recent.filter(item => item && item.text === text).length;
    const recentClicheFamily = base > 0 ? recent.filter(item => item && item.text !== text && baseScore(item.text) > 0).length : 0;
    return Math.min(1, base + recentRepeat * 0.15 + recentClicheFamily * 0.05);
  }

  return { score, baseScore, CLICHE_PATTERNS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ClicheScore;
