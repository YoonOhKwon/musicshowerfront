// Open-world genre labels are admitted by linguistic shape, never by membership in a catalog.
// This keeps genuinely unfamiliar genres possible while preventing a full Flamingo description
// from becoming the primary genre merely because it arrived in the wrong JSON field.
const GenreLabelShape = (() => {
  const ENGLISH_SENTENCE_VERB = /\b(?:is|are|was|were|has|have|had|provides?|features?|blends?|combines?|creates?|uses?|drives?|sounds?|feels?|evokes?|contains?|includes?|supports?|adds?|builds?|delivers?|showcases?|characteri[sz](?:e|es|ed)|dominat(?:e|es|ed))\b/i;
  const KOREAN_SENTENCE_ENDING = /(?:한다|하다|이다|이며|있다|없다|느껴진다|들린다|돋보인다|제공한다|만든다|보여준다|이어진다|강조된다|형성한다)(?:고|며|지만|다)?$/;
  const SENTENCE_OPENING = /^(?:a|an|the|this|that|these|those|it|there|track|song|music|recording|mix)\b/i;
  const MUSICAL_DESCRIPTION = /\b(?:bpm|beat|drums?|kick|snare|hi-?hat|bassline|bass|vocals?|synths?|pads?|piano|guitars?|rhythm|groove|harmony|harmonic|melody|arpeggio|production|mix|texture)\b|(?:킥|스네어|하이햇|베이스|보컬|신스|피아노|기타|리듬|그루브|화성|하모니|멜로디|프로덕션|믹스|텍스처)/i;
  const CONTEXT_DESCRIPTION = /\b(?:scene|culture|era|lineage|retro|vintage|nostalgi|futurist|cyberpunk|y2k|19\d0s|20\d0s)\b|(?:씬|문화|시대|연대|계보|복고|향수|미학)/i;

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

  function fallbackCategory(value) {
    const text = clean(value);
    if (MUSICAL_DESCRIPTION.test(text)) return "production";
    if (CONTEXT_DESCRIPTION.test(text)) return "association";
    return "mood";
  }

  return { isPlausibleGenreLabel, fallbackCategory };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreLabelShape;
