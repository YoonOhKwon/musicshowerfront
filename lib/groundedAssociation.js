"use strict";

// Grounded association: culture, era, imagery and aesthetic words drawn by a language model from
// evidence that listening models produced. The language model never hears the audio, so every word
// must cite evidence ids, and how genre-specific a word may be is capped by how well the genre
// identity is corroborated. There is no genre, scene or vocabulary table here: the prompt only
// describes categories, anchoring rules and resolution tiers.

const HANGUL = /[가-힣]/;
const CATEGORIES = ["culture", "era", "imagery", "aesthetic"];
const TIERS = ["broad", "family", "specific"];
const FAMILY_MIN_CONFIDENCE = 0.35;
const SPECIFIC_MIN_CONFIDENCE = 0.55;
const PER_CATEGORY_LIMIT = 5;
const MAX_FLAMINGO_EVIDENCE = 30;

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const normalizeKey = text => String(text || "").toLowerCase().replace(/[\s·.,'’"-]+/g, "");

// How genre-specific associations may be, from the fused genre hypotheses. "specific" needs a
// confident identity that more than one listener or more than one capture stands behind.
function resolutionTier(state = {}) {
  const hypotheses = state.genreReasoning?.hypotheses || [];
  const top = hypotheses[0];
  const fallback = state.genre?.primary ? { genre: state.genre.primary,
    semanticConfidence: state.genre.semanticConfidence ?? state.genre.confidence } : null;
  const primary = top || fallback;
  const confidence = clamp(primary?.semanticConfidence);
  const corroborated = (top?.independentEvidenceCount || 0) >= 2 || (top?.temporalSupport || 0) >= 2;
  const tier = !primary || confidence < FAMILY_MIN_CONFIDENCE ? "broad"
    : confidence >= SPECIFIC_MIN_CONFIDENCE && corroborated ? "specific" : "family";
  return { tier, primary: primary ? { label: primary.genre, confidence: Number(confidence.toFixed(2)),
    corroborated } : null };
}

// Evidence ids: G = fused genre hypothesis, K = classifier prediction, F = Flamingo concept,
// C = Flamingo style cue. Ids are regenerated per call and resolved back to text for display.
function buildEvidence({ state = {}, concepts = [], cues = [] } = {}) {
  const items = [];
  const hypotheses = (state.genreReasoning?.hypotheses || []).slice(0, 4);
  hypotheses.forEach((item, index) => items.push({ id: `G${index + 1}`, kind: "genre", text: item.genre,
    confidence: Number(clamp(item.semanticConfidence).toFixed(2)),
    listeners: item.independentEvidenceCount || 1, captures: item.temporalSupport || 1 }));
  (state.classifierGenre?.topK || []).slice(0, 3).forEach((item, index) => items.push({ id: `K${index + 1}`,
    kind: "classifier", text: item.label, confidence: Number(clamp(item.semanticConfidence ?? item.confidence).toFixed(2)) }));
  concepts
    .filter(entry => entry.category !== "genre" && entry.canonicalText)
    .sort((a, b) => (b.confidence || 0) * (b.segments || 1) - (a.confidence || 0) * (a.segments || 1))
    .slice(0, MAX_FLAMINGO_EVIDENCE)
    .forEach((entry, index) => items.push({ id: `F${index + 1}`, kind: "flamingo", layer: entry.layer,
      category: entry.category, text: entry.canonicalText, confidence: Number(clamp(entry.confidence).toFixed(2)),
      captures: entry.segments || 1 }));
  cues.slice(0, 12).forEach((cue, index) => items.push({ id: `C${index + 1}`, kind: "styleCue", text: cue.text,
    confidence: Number(clamp(cue.confidence).toFixed(2)), captures: cue.count || 1 }));
  return items;
}

function buildAssociationPrompt({ evidence = [], tier = "broad", alreadyShown = [] } = {}) {
  return `You are Music Shower's grounded association stage. Music Flamingo listened to the audio and a genre classifier also listened; you did not hear it. From ONLY the evidence below, propose words a listener of this music would associate with it, in four categories:
- culture: scenes, subcultures, media or internet cultures, movements, regional music cultures.
- era: periods, decades, historical, technological or economic moments.
- imagery: concrete visual images - places, times of day, objects, media artifacts, colors, light, motion.
- aesthetic: named aesthetics and styles of taste.

Resolution tier: ${tier}
- broad: the genre identity is not established. Produce NO culture or era items. Imagery and aesthetic must follow from Flamingo aesthetic, impression, or style-cue evidence.
- family: a genre family is plausible. Culture and era may name family-level lineage; avoid references specific to one microgenre.
- specific: the genre identity is corroborated. Scenes, eras, places, and media references characteristic of that genre are appropriate.

Rules:
- Every item cites "anchors", ids from the evidence. culture and era cite at least one genre id (G or K) AND at least one listening id (F or C). imagery and aesthetic cite at least one listening id (F or C) and may add genre ids.
- Draw on well-established cultural knowledge about the cited genres and cues. Do not claim a place, date, work, artist, franchise, or sample source for this particular recording.
- Vary the angle across items (place, time, medium, object, color and light, motion, community). Do not repeat or paraphrase an item or anything in alreadyShown.
- "ko": natural Korean display text of 1-5 words. Keep internationally used scene, genre, or aesthetic names in their usual Latin spelling when Korean listeners write them that way. "en": natural English of 1-5 words.
- "specificity": "broad", "family", or "specific" - how genre-specific the word is. It must not exceed the tier.
- At most ${PER_CATEGORY_LIMIT} items per category. Fewer, or none, is correct when the evidence is thin.
Return exactly one JSON object: {"items":[{"category":"culture","ko":"...","en":"...","anchors":["G1","F2"],"confidence":0.0,"specificity":"family"}]}

Evidence:
${JSON.stringify(evidence)}

alreadyShown:
${JSON.stringify(alreadyShown.slice(-60))}`;
}

function cleanSurface(value, { korean }) {
  const text = String(value || "").replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’.。]+$/g, "").trim();
  if (!text || text.length > (korean ? 30 : 48) || /[\n.!?;{}<>]/.test(text)) return "";
  if (text.split(" ").length > (korean ? 6 : 7)) return "";
  if (!korean && HANGUL.test(text)) return "";
  return text;
}

// Enforces what the prompt asks for. Returns accepted items and a count per rejection reason, so
// anchor validity can be measured instead of assumed.
function validateAssociations(parsed, { evidence = [], tier = "broad", alreadyShown = [] } = {}) {
  const byId = new Map(evidence.map(item => [item.id, item]));
  const seen = new Set(alreadyShown.map(normalizeKey));
  const perCategory = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  const rejected = {};
  const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  const accepted = [];
  const proposals = Array.isArray(parsed?.items) ? parsed.items : [];
  for (const proposal of proposals) {
    const category = String(proposal?.category || "").toLowerCase();
    if (!CATEGORIES.includes(category)) { reject("category"); continue; }
    if (tier === "broad" && ["culture", "era"].includes(category)) { reject("tier-category"); continue; }
    const specificity = TIERS.includes(proposal?.specificity) ? proposal.specificity : "family";
    if (TIERS.indexOf(specificity) > TIERS.indexOf(tier)) { reject("over-specific"); continue; }
    const ko = cleanSurface(proposal?.ko, { korean: true });
    const en = cleanSurface(proposal?.en, { korean: false });
    if (!ko || !en) { reject("surface"); continue; }
    const anchorIds = [...new Set((Array.isArray(proposal?.anchors) ? proposal.anchors : []).map(String))];
    const anchors = anchorIds.map(id => byId.get(id)).filter(Boolean);
    if (!anchors.length || anchors.length !== anchorIds.length) { reject("invalid-anchor"); continue; }
    const listening = anchors.filter(item => ["flamingo", "styleCue"].includes(item.kind));
    const genre = anchors.filter(item => ["genre", "classifier"].includes(item.kind) && item.confidence >= FAMILY_MIN_CONFIDENCE);
    if (!listening.length) { reject("no-listening-anchor"); continue; }
    if (["culture", "era"].includes(category) && !genre.length) { reject("no-genre-anchor"); continue; }
    const key = normalizeKey(ko);
    if (seen.has(key) || seen.has(normalizeKey(en))) { reject("duplicate"); continue; }
    if (perCategory[category] >= PER_CATEGORY_LIMIT) { reject("category-limit"); continue; }
    seen.add(key);
    seen.add(normalizeKey(en));
    perCategory[category] += 1;
    accepted.push({ category, text: ko, textEn: en, specificity, confidence: Number(clamp(proposal?.confidence ?? 0.6).toFixed(2)),
      anchors: anchors.map(item => ({ id: item.id, kind: item.kind, text: item.text })),
      genreConfidence: genre.length ? Math.max(...genre.map(item => item.confidence)) : 0 });
  }
  return { accepted, rejected, proposed: proposals.length };
}

// Which accepted associations may be shown on screen (all remain visible in the inspector).
// - "broad" words are excluded: in the four-track blind evaluation they rated 0.58-0.71 genericness
//   (0 = tied to a genre, 1 = fits any music) against 0.12-0.32 for "family" words.
// - A word anchored on genre evidence is shown only while one of those genres is still among the
//   current hypotheses, so words from an abandoned early genre reading do not linger.
function displayableAssociations(items = [], state = {}) {
  const current = new Set([
    ...(state.genreReasoning?.hypotheses || []).slice(0, 4).map(item => normalizeKey(item.genre)),
    ...(state.classifierGenre?.topK || []).slice(0, 3).map(item => normalizeKey(item.label))
  ]);
  return items.filter(item => {
    if (item.specificity === "broad") return false;
    const genreAnchors = (item.anchors || []).filter(anchor => ["genre", "classifier"].includes(anchor.kind));
    return !genreAnchors.length || genreAnchors.some(anchor => current.has(normalizeKey(anchor.text)));
  });
}

const DISPLAY_FACETS = {
  culture: { category: "culture", layer: "CONTEXT" },
  era: { category: "era", layer: "CONTEXT" },
  imagery: { category: "imagery", layer: "AESTHETIC" },
  aesthetic: { category: "association", layer: "AESTHETIC" }
};

// Display-pool candidate for an accepted association. associationAnchors is what the shared
// ownership gate (SemanticFacets.isGroundedAssociation) requires before anything is shown.
function toCandidate(item) {
  const facet = DISPLAY_FACETS[item.category];
  return { text: item.text, textEn: item.textEn, canonicalText: item.textEn, sourceText: item.textEn,
    category: facet.category, layer: facet.layer, associationCategory: item.category,
    source: "groundedAssociation", sourceFamily: "groundedAssociation", sourceModel: "language-model",
    associationAnchors: (item.anchors || []).map(anchor => anchor.text || anchor),
    genreConfidence: item.genreConfidence || 0, specificity: item.specificity === "specific" ? 0.8 : item.specificity === "family" ? 0.62 : 0.5,
    confidence: item.confidence, score: item.confidence, weight: item.confidence, kind: "style", anchors: [] };
}

function createGroundedAssociator({ client = null, model = "" } = {}) {
  async function associate({ evidence = [], tier = "broad", alreadyShown = [] } = {}, signal) {
    if (!client) return { accepted: [], rejected: {}, proposed: 0, skipped: "no-client" };
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: buildAssociationPrompt({ evidence, tier, alreadyShown }) }],
      response_format: { type: "json_object" },
      // A reasoning model spends completion tokens before writing; at 2500 one of three calls in the
      // first evaluation came back empty with the budget used up.
      reasoning_effort: "low",
      max_completion_tokens: 6000
    }, { signal, timeout: 90000, maxRetries: 0 });
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new Error(`empty association response (finish: ${choice?.finish_reason || "unknown"})`);
    return validateAssociations(JSON.parse(content), { evidence, tier, alreadyShown });
  }
  return { associate };
}

module.exports = { CATEGORIES, TIERS, FAMILY_MIN_CONFIDENCE, SPECIFIC_MIN_CONFIDENCE, resolutionTier,
  buildEvidence, buildAssociationPrompt, validateAssociations, displayableAssociations, toCandidate,
  createGroundedAssociator };
