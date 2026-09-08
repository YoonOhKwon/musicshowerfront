// A compact, provenance-safe handoff from the fixed-label local classifier to Music Flamingo.
// The fused `state.genre` is deliberately forbidden here: it may already contain an earlier
// Flamingo hypothesis, which would turn the next assisted listen into a self-confirming loop.
const GenreAdvisory = (() => {
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const MIN_RELIABLE_CONFIDENCE = 0.43;
  const HIGH_ENTROPY = 0.90;
  const LOW_MARGIN = 0.012;

  function cleanLabel(value) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
  }

  function sanitize(value = {}) {
    if (!value || typeof value !== "object") return null;
    const seen = new Set();
    const candidates = [];
    for (const raw of Array.isArray(value.candidates) ? value.candidates : []) {
      const label = cleanLabel(raw?.label ?? raw?.name ?? raw);
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        label,
        score: clamp(raw?.score ?? raw?.confidence),
        rank: candidates.length + 1
      });
      if (candidates.length >= 5) break;
    }
    if (!candidates.length) return null;
    const uncertainty = value.uncertainty && typeof value.uncertainty === "object"
      ? {
          margin: clamp(value.uncertainty.margin),
          entropy: Number.isFinite(Number(value.uncertainty.entropy))
            ? clamp(value.uncertainty.entropy) : 1,
          uncertain: Boolean(value.uncertainty.uncertain),
          semanticConfidence: clamp(value.uncertainty.semanticConfidence)
        }
      : { margin: 0, entropy: 1, uncertain: true, semanticConfidence: 0 };
    return { schemaVersion: 1, source: "classifier-only", candidates, uncertainty };
  }

  function isReliable(value = {}) {
    const advisory = sanitize(value);
    if (!advisory || advisory.uncertainty.uncertain) return false;
    const { semanticConfidence, entropy, margin } = advisory.uncertainty;
    return semanticConfidence >= MIN_RELIABLE_CONFIDENCE &&
      !(entropy > HIGH_ENTROPY && margin < LOW_MARGIN);
  }

  function build(state = {}) {
    const classifier = state.classifierGenre || {};
    // A shortlist is useful only when the classifier has earned an actual opinion. Passing an
    // uncertain ranking to a language model does not add evidence; it merely turns small score
    // noise into a prompt anchor. Missing certainty metadata is treated as uncertain, too.
    const semanticConfidence = Number(classifier.semanticConfidence ?? classifier.confidence);
    const margin = Number(classifier.margin);
    const entropy = Number(classifier.entropy ?? classifier.rawEntropy);
    if (classifier.uncertain !== false || classifier.unknown === true ||
      !Number.isFinite(semanticConfidence) || semanticConfidence < MIN_RELIABLE_CONFIDENCE ||
      (Number.isFinite(entropy) && Number.isFinite(margin) &&
        entropy > HIGH_ENTROPY && margin < LOW_MARGIN)) return null;
    // `classifierRawTopK` is the closest view of the Discogs head. `classifierGenre.topK` is an
    // acceptable fallback because classifierGenre is kept separate from the later genreReasoning
    // merge; never fall back to state.genre.topK.
    const raw = Array.isArray(classifier.classifierRawTopK) && classifier.classifierRawTopK.length
      ? classifier.classifierRawTopK : classifier.topK;
    return sanitize({
      candidates: (raw || []).map(item => ({
        label: item?.label ?? item?.name ?? item,
        score: item?.confidence ?? item?.score
      })),
      uncertainty: {
        margin: classifier.margin,
        entropy: classifier.entropy ?? classifier.rawEntropy,
        uncertain: classifier.uncertain,
        semanticConfidence
      }
    });
  }

  function encode(value) {
    const advisory = sanitize(value);
    if (!advisory) return "";
    const json = JSON.stringify(advisory);
    if (typeof Buffer !== "undefined") return Buffer.from(json, "utf8").toString("base64url");
    if (typeof TextEncoder === "undefined" || typeof btoa !== "function") return "";
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function decode(header) {
    const encoded = String(header || "");
    if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
      let json;
      if (typeof Buffer !== "undefined") json = Buffer.from(encoded, "base64url").toString("utf8");
      else {
        if (typeof atob !== "function" || typeof TextDecoder === "undefined") return null;
        const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4);
        const binary = atob(padded);
        json = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
      }
      if (json.length > 2048) return null;
      return sanitize(JSON.parse(json));
    } catch {
      return null;
    }
  }

  // Word-pool generation is always blind. Assisted listening is not used as a second
  // independent vote; classifier labels reach CONTEXT only through /api/compose-genre.
  function shouldAssist() {
    return false;
  }

  return { build, sanitize, isReliable, encode, decode, shouldAssist };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreAdvisory;
