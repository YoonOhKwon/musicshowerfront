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
// Evidence caps keep the association prompt from growing with every capture (token budget).
const MAX_FLAMINGO_EVIDENCE = 16;
const MAX_STYLE_CUES = 6;
// Local measurement thresholds, from scripts/calibrate-loop-evidence.cjs over 9 tracks: bar-to-bar repetition
// stayed at 0.24-0.33 on a live brass recording and at or below 0.50 on non-loop electronic tracks, while
// live capture windows of sample-built tracks peaked at 0.57-0.69 (0.70 was never reached twice there).
// One window can be a coincidence, so a state needs agreement across captures.
const LOOP_REPETITION = 0.55;
const LOW_REPETITION = 0.4;
const SIDECHAIN = 0.35;
const CONSENSUS_WINDOW = 4;
const LISTENING_KINDS = new Set(["flamingo", "styleCue", "forensic", "measurement"]);

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const normalizeKey = text => String(text || "").toLowerCase().replace(/[\s·.,'’"-]+/g, "");
const shortCue = (text, limit = 110) => {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).replace(/[\s,;:-]+$/, "");
};

// Agreement on how the recording was made, across recent captures. forensics: one answer list per
// Flamingo forensic listen; measurements: one lib/loopEvidence.js result per capture window.
function productionConsensus({ forensics = [], measurements = [] } = {}) {
  const windows = measurements.slice(-CONSENSUS_WINDOW).filter(Boolean);
  const count = test => windows.filter(test).length;
  const loop = count(item => item.loopRepetition >= LOOP_REPETITION) >= 2 ? "loop-like"
    : count(item => item.loopRepetition !== null && item.loopRepetition < LOW_REPETITION) >= 2 ? "varied" : null;
  // An answer whose polarity was inferred from a description (no leading yes/no) is dropped when the
  // local measurement contradicts it. On the live brass recording, two descriptive listens claimed "a
  // sampled drum break" while every measured window varied (max bar repetition 0.27).
  const contradicted = item => Boolean(item.inferred) && item.key !== "vocals" &&
    ((loop === "varied" && item.answer === "yes") || (loop === "loop-like" && item.answer === "no"));
  const answers = {};
  const recentFor = key => forensics.slice(-3).map(list => (list || []).find(item => item.key === key)).filter(Boolean);
  for (const key of ["sampled", "vocals", "loop"]) {
    const recent = recentFor(key).filter(item => !contradicted(item));
    for (const polarity of ["yes", "no"]) {
      const agreeing = recent.filter(item => item.answer === polarity);
      if (agreeing.length >= 2 && agreeing.length > recent.length - agreeing.length) {
        answers[key] = { answer: polarity, captures: agreeing.length,
          cues: [...new Set(agreeing.map(item => item.cue).filter(Boolean))].slice(-2) };
      }
    }
  }
  // The processing and source-period questions are open ("what processing", "what period") and
  // describe the sampled source material, so they are passed on only once sampling or looping is agreed.
  // On a live brass recording two of five listens wrongly described "a sampled drum break"; without
  // this gate that text alone produced sample-culture associations.
  if (answers.sampled?.answer === "yes" || answers.loop?.answer === "yes") {
    for (const key of ["processing", "sourcePeriod"]) {
      const described = recentFor(key).filter(item => item.cue);
      if (described.length >= 2) {
        answers[key] = { answer: "reported", captures: described.length,
          cues: [...new Set(described.map(item => item.cue))].slice(-2) };
      }
    }
  }
  const sidechain = count(item => item.sidechain >= SIDECHAIN) >= 2;
  const tempos = windows.map(item => item.tempoBpm).filter(Number.isFinite).sort((a, b) => a - b);
  const loopScores = windows.map(item => item.loopRepetition).filter(Number.isFinite);
  // Sampled or looped material heard by Flamingo AND bar-exact repetition measured locally: two
  // independent listeners agreeing on a production identity, which licenses specific associations.
  const corroborated = loop === "loop-like" && (answers.sampled?.answer === "yes" || answers.loop?.answer === "yes");
  return { answers, loop, sidechain, windows: windows.length, corroborated,
    tempoBpm: tempos.length ? tempos[Math.floor(tempos.length / 2)] : null,
    maxLoopRepetition: loopScores.length ? Math.max(...loopScores) : null };
}

// How genre-specific associations may be, from the fused genre hypotheses. "specific" needs a
// confident identity that more than one listener or more than one capture stands behind, or a
// confident genre plus corroborated production evidence (see productionConsensus).
function resolutionTier(state = {}, production = null) {
  const hypotheses = state.genreReasoning?.hypotheses || [];
  const top = hypotheses[0];
  const fallback = state.genre?.primary ? { genre: state.genre.primary,
    semanticConfidence: state.genre.semanticConfidence ?? state.genre.confidence } : null;
  const primary = top || fallback;
  const confidence = clamp(primary?.semanticConfidence);
  const corroborated = (top?.independentEvidenceCount || 0) >= 2 || (top?.temporalSupport || 0) >= 2;
  const productionCorroborated = Boolean(production?.corroborated);
  const tier = !primary || confidence < FAMILY_MIN_CONFIDENCE ? "broad"
    : confidence >= SPECIFIC_MIN_CONFIDENCE && (corroborated || productionCorroborated) ? "specific" : "family";
  return { tier, primary: primary ? { label: primary.genre, confidence: Number(confidence.toFixed(2)),
    corroborated, productionCorroborated } : null };
}

// Evidence ids: G = fused genre hypothesis, K = classifier prediction, F = Flamingo concept,
// C = Flamingo style cue, Q = agreed Flamingo forensic answer, M = agreed local measurement. Ids are
// regenerated per call and resolved back to text for display. `signature` identifies an item across
// calls without its changing numbers, so a new call is made only for genuinely new evidence.
function buildEvidence({ state = {}, concepts = [], cues = [], production = null } = {}) {
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
  cues.slice(0, MAX_STYLE_CUES).forEach((cue, index) => items.push({ id: `C${index + 1}`, kind: "styleCue", text: cue.text,
    confidence: Number(clamp(cue.confidence).toFixed(2)), captures: cue.count || 1 }));
  Object.entries(production?.answers || {}).forEach(([key, value], index) => items.push({ id: `Q${index + 1}`,
    kind: "forensic", signature: `forensic:${key}:${value.answer}`,
    // Forensic answers run to a few sentences; the latest cue, cut to its opening, carries the finding
    // at a fraction of the prompt tokens.
    text: `${key}: ${value.answer}${value.cues.length ? ` - ${shortCue(value.cues.at(-1))}` : ""}`, captures: value.captures }));
  const measured = [];
  if (production?.loop === "loop-like") measured.push({ signature: "measurement:loop",
    text: `bar-exact loop repetition measured (max bar correlation ${production.maxLoopRepetition})` });
  if (production?.loop === "varied") measured.push({ signature: "measurement:varied",
    text: "bars vary from one another; no exact loop measured" });
  if (production?.sidechain) measured.push({ signature: "measurement:sidechain", text: "beat-aligned sidechain ducking measured" });
  if (measured.length && production.tempoBpm) measured[0].text += `, tempo about ${Math.round(production.tempoBpm)} BPM`;
  measured.forEach((item, index) => items.push({ id: `M${index + 1}`, kind: "measurement", ...item }));
  for (const item of items) item.signature ||= `${item.kind}:${item.text}`;
  return items;
}

function buildAssociationPrompt({ evidence = [], tier = "broad", alreadyShown = [] } = {}) {
  return `You are Music Shower's grounded association stage. Music Flamingo listened to the audio, a genre classifier also listened, and a local analyzer measured the signal; you did not hear it. From ONLY the evidence below, propose words a listener of this music would associate with it, in four categories:
- culture: scenes, subcultures, media or internet cultures, movements, regional music cultures.
- era: periods, decades, historical, technological or economic moments.
- imagery: concrete visual images - places, times of day, objects, media artifacts, colors, light, motion.
- aesthetic: named aesthetics and styles of taste.

Resolution tier: ${tier}
- broad: the genre identity is not established. Produce NO culture or era items. Imagery and aesthetic must follow from Flamingo aesthetic, impression, or style-cue evidence.
- family: a genre family is plausible. Culture and era may name family-level lineage; avoid references specific to one microgenre.
- specific: the genre identity is corroborated. Scenes, eras, places, and media references characteristic of that genre are appropriate.

Forensic answers (Q) say how the recording was made: whether material is sampled or looped, the vocals and their treatment, and how old any source material sounds. Measurements (M) are signal analysis. When they agree that older material was sampled or looped, the lineage of that source material and the culture of re-using it are grounded associations.

Rules:
- Every item cites "anchors", ids from the evidence. culture and era cite at least one genre id (G or K) AND at least one listening id (F, C, Q or M). imagery and aesthetic cite at least one listening id (F, C, Q or M) and may add genre ids.
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
    const listening = anchors.filter(item => LISTENING_KINDS.has(item.kind));
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
      max_completion_tokens: 4000
    }, { signal, timeout: 90000, maxRetries: 0 });
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new Error(`empty association response (finish: ${choice?.finish_reason || "unknown"})`);
    return validateAssociations(JSON.parse(content), { evidence, tier, alreadyShown });
  }
  return { associate };
}

module.exports = { CATEGORIES, TIERS, FAMILY_MIN_CONFIDENCE, SPECIFIC_MIN_CONFIDENCE, LOOP_REPETITION, productionConsensus, resolutionTier,
  buildEvidence, buildAssociationPrompt, validateAssociations, displayableAssociations, toCandidate,
  createGroundedAssociator };
