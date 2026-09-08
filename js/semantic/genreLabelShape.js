// Open-world genre labels are admitted by linguistic shape, never by membership in a catalog.
// This keeps genuinely unfamiliar genres possible while preventing a full Flamingo description
// from becoming the primary genre merely because it arrived in the wrong JSON field.
const GenreLabelShape = (() => {
  const ENGLISH_SENTENCE_VERB = /\b(?:is|are|was|were|has|have|had|provides?|features?|blends?|combines?|creates?|uses?|drives?|sounds?|feels?|evokes?|contains?|includes?|supports?|adds?|builds?|delivers?|showcases?|characteri[sz](?:e|es|ed)|dominat(?:e|es|ed))\b/i;
  const KOREAN_SENTENCE_ENDING = /(?:한다|하다|이다|이며|있다|없다|느껴진다|들린다|돋보인다|제공한다|만든다|보여준다|이어진다|강조된다|형성한다)(?:고|며|지만|다)?$/;
  const SENTENCE_OPENING = /^(?:a|an|the|this|that|these|those|it|there|track|song|music|recording|mix)\b/i;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isPlausibleGenreLabel(value) {
    const text = clean(value);
    if (!text || text.length > 64 || /[.!?。！？]/.test(text)) return false;
    const words = text.match(/[\p{L}\p{N}&/+.'’-]+/gu) || [];
    if (!words.length || words.length > 7) return false;
    if (SENTENCE_OPENING.test(text) || ENGLISH_SENTENCE_VERB.test(text) || KOREAN_SENTENCE_ENDING.test(text)) return false;
    return true;
  }

  function fallbackCategory() {
    return null;
  }

  return { isPlausibleGenreLabel, fallbackCategory };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreLabelShape;
