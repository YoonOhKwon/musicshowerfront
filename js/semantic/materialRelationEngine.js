// Local, non-generative relations between verified musical materials.
// A relation is emitted only when independent evidence, temporal coincidence, and a
// musically meaningful link are all present. No genre, verse/chorus, or aesthetic claims.
const MaterialRelationEngine = (() => {
  const axesApi = () => (typeof EvidenceAxis !== "undefined" ? EvidenceAxis : require("./evidenceAxis"));
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  const TYPES = Object.freeze([
    "LOCK", "OFFSET", "SUPPORT", "RESPONSE", "CONTRAST", "REPEAT", "FOLLOW", "LEAD",
    "LAYER", "EXCHANGE", "BUILD", "THIN", "DENSE", "OPEN", "CLOSE", "PUMP", "FILTER",
    "SPACE", "TRANSITION"
  ]);

  function read(source, path) {
    return String(path || "").split(".").filter(Boolean)
      .reduce((value, key) => value == null ? undefined : value[key], source);
  }

  function num(...values) {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  }

  function findInstrument(observed, pattern) {
    return (observed || []).find(item => pattern.test(String(item.id || item.label || "")));
  }

  function hasClaim(store, concept) {
    return Boolean(store?.byConcept?.[concept] || store?.licensed?.has?.(concept));
  }

  function context(state = {}) {
    const primitives = state.primitives || {};
    const observed = state.instrumentation?.observed || [];
    return {
      state,
      store: state.verifiedClaims || {},
      primitives,
      grammar: state.rhythmicGrammar || {},
      production: state.productionEvidence || {},
      observed,
      character: state.trackCharacter || {},
      performance: state.performance || {},
      expression: state.expressionFeatures || {},
      form: primitives.form || {},
      arrangement: primitives.arrangement || state.arrangement || {},
      voice: findInstrument(observed, /voice|vocal/i),
      synth: findInstrument(observed, /synth/i),
      bass: findInstrument(observed, /bass/i),
      drums: findInstrument(observed, /drum|kick|percussion/i)
    };
  }

  function relation({
    relationId, relationType, subjectConceptId, objectConceptId, confidence, anchors,
    category = "arrangement", temporalScope = "LOCAL_STATE", salience = null, minAxes = 2
  }) {
    const evidenceAxes = axesApi().independentAxes(anchors);
    return {
      relationId,
      relationType,
      subjectConceptId,
      objectConceptId,
      confidence: clamp(confidence),
      salience: clamp(salience ?? confidence),
      anchors,
      temporalScope,
      evidenceAxes,
      minAxes,
      category,
      source: "material-relation"
    };
  }

  function sufficient(rel, { minConfidence = 0.55 } = {}) {
    return rel && TYPES.includes(rel.relationType) && rel.confidence >= minConfidence
      && (rel.evidenceAxes || []).length >= (rel.minAxes ?? 2);
  }

  function evaluate(state = {}) {
    const ctx = context(state);
    const candidates = [];
    const rejected = [];
    const consider = (rel, reason) => {
      if (!rel) return;
      if (!sufficient(rel)) {
        rejected.push({ relationId: rel.relationId, reason: reason || "insufficient-evidence" });
        return;
      }
      candidates.push(rel);
    };

    consider(lockKickBass(ctx));
    consider(offsetBass(ctx));
    consider(layerVocalSynth(ctx));
    consider(contrastVocalBass(ctx));
    consider(contrastThinBass(ctx));
    consider(repeatSampleCell(ctx));
    consider(repeatKickBass(ctx));
    consider(responseCall(ctx), "response-needs-recurrence");
    consider(followHarmony(ctx));
    consider(leadOverAccompaniment(ctx));
    consider(exchangeLeads(ctx));
    consider(buildArrangement(ctx));
    consider(thinArrangement(ctx));
    consider(densePercussion(ctx));
    consider(openAfterTransition(ctx));
    consider(closeAfterTransition(ctx));
    consider(pumpSidechain(ctx));
    consider(filterWithDensity(ctx));
    consider(spaceField(ctx));
    consider(sectionTransition(ctx));

    candidates.sort((a, b) => b.confidence - a.confidence || a.relationId.localeCompare(b.relationId));
    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      if (seen.has(item.relationId)) continue;
      seen.add(item.relationId);
      unique.push(item);
    }
    const relations = unique.slice(0, 8);
    return {
      relations,
      debug: {
        incomingMaterials: ctx.observed.length + (ctx.store.items?.length || 0),
        considered: candidates.length,
        emitted: relations.length,
        rejected,
        types: relations.map(item => item.relationType)
      }
    };
  }

  function lockKickBass(ctx) {
    const kickPeriod = num(ctx.primitives.pulse?.kickPeriodicity, ctx.grammar.kickPeriodicity, ctx.grammar.fourOnFloor);
    const alignment = num(ctx.primitives.bass?.bassKickInteraction, ctx.performance.bassKickInteraction);
    const bassPresent = (ctx.bass?.confidence || 0) >= 0.5
      || num(ctx.primitives.bass?.bassPresence) >= 0.55;
    if (!bassPresent || kickPeriod == null || alignment == null) return null;
    if (kickPeriod < 0.7 || alignment < 0.62) return null;
    return relation({
      relationId: "bass.kick.lock",
      relationType: "LOCK",
      subjectConceptId: "bass",
      objectConceptId: "kick",
      confidence: Math.min(kickPeriod, alignment),
      anchors: ["primitives.pulse.kickPeriodicity", "primitives.bass.bassKickInteraction"],
      category: "performance"
    });
  }

  function offsetBass(ctx) {
    const bassPresent = (ctx.bass?.confidence || 0) >= 0.5
      || num(ctx.primitives.bass?.bassPresence) >= 0.55;
    const alignment = num(ctx.primitives.bass?.bassKickInteraction, ctx.performance.bassKickInteraction);
    const syncopation = num(
      ctx.primitives.bass?.syncopation,
      ctx.performance.bassSyncopation,
      ctx.primitives.pulse?.syncopation,
      ctx.grammar.syncopation
    );
    if (!bassPresent || alignment == null || syncopation == null) return null;
    if (alignment > 0.4 || syncopation < 0.6) return null;
    return relation({
      relationId: "bass.offset_from_pulse",
      relationType: "OFFSET",
      subjectConceptId: "bass",
      objectConceptId: "pulse",
      confidence: clamp(syncopation * 0.65 + (1 - alignment) * 0.35),
      anchors: ["primitives.bass.bassKickInteraction", "primitives.pulse.syncopation"],
      category: "performance"
    });
  }

  function layerVocalSynth(ctx) {
    if ((ctx.voice?.confidence || 0) < 0.5 || (ctx.synth?.confidence || 0) < 0.5) return null;
    return relation({
      relationId: "vocal.synth.layer",
      relationType: "LAYER",
      subjectConceptId: "vocal",
      objectConceptId: "synth",
      confidence: Math.min(ctx.voice.confidence, ctx.synth.confidence),
      anchors: ["instrumentation.observed", "primitives.role.foregroundLikelihood"],
      category: "arrangement"
    });
  }

  function contrastVocalBass(ctx) {
    if ((ctx.voice?.confidence || 0) < 0.5 || (ctx.bass?.confidence || 0) < 0.5) return null;
    if ((ctx.voice.dominance || 0) <= (ctx.bass.dominance || 0) + 0.12) return null;
    return relation({
      relationId: "vocal.ahead_of_bass",
      relationType: "CONTRAST",
      subjectConceptId: "vocal",
      objectConceptId: "bass",
      confidence: clamp(0.62 + ((ctx.voice.dominance || 0) - (ctx.bass.dominance || 0))),
      anchors: ["instrumentation.observed", "moodDimensions.weight"],
      category: "arrangement"
    });
  }

  function contrastThinBass(ctx) {
    const sub = num(ctx.character.production?.subWeight, ctx.primitives.production?.lowEndWeight);
    const density = num(ctx.character.texture?.density, ctx.primitives.form?.density, ctx.arrangement.density);
    if (sub == null || density == null || sub > 0.38 || density < 0.55) return null;
    return relation({
      relationId: "texture.thin_low_end",
      relationType: "CONTRAST",
      subjectConceptId: "bass",
      objectConceptId: "texture",
      confidence: clamp(density * 0.5 + (1 - sub) * 0.5),
      anchors: ["trackCharacter.production.subWeight", "trackCharacter.texture.density"],
      category: "production"
    });
  }

  function repeatSampleCell(ctx) {
    if (!hasClaim(ctx.store, "recurring_motif") || !hasClaim(ctx.store, "sample_based")) return null;
    const motif = num(ctx.primitives.melody?.motifRecurrence, ctx.store.byConcept?.recurring_motif?.confidence);
    const sample = num(ctx.production.sampleBased, ctx.store.byConcept?.sample_based?.confidence);
    return relation({
      relationId: "sample.cell.repeat",
      relationType: "REPEAT",
      subjectConceptId: "sample",
      objectConceptId: "motif",
      confidence: Math.min(motif || 0.7, sample || 0.7),
      anchors: ["primitives.melody.motifRecurrence", "productionEvidence.sampleBased"],
      category: "production"
    });
  }

  function repeatKickBass(ctx) {
    if (!hasClaim(ctx.store, "four_on_floor") || (ctx.bass?.confidence || 0) < 0.55) return null;
    const repetition = num(ctx.character.structure?.repetition, ctx.primitives.form?.repetitionDepth);
    if (repetition == null || repetition < 0.6) return null;
    return relation({
      relationId: "bass.kick.repeat",
      relationType: "REPEAT",
      subjectConceptId: "bass",
      objectConceptId: "kick",
      confidence: Math.min(ctx.store.byConcept.four_on_floor.confidence, repetition),
      anchors: ["rhythmicGrammar.fourOnFloor", "trackCharacter.structure.repetition"],
      category: "arrangement"
    });
  }

  function responseCall(ctx) {
    const likelihood = num(ctx.primitives.melody?.callResponseLikelihood);
    const role = num(ctx.primitives.role?.callResponse);
    const instrument = num(ctx.primitives.instrument?.callResponse);
    const recurrence = num(ctx.primitives.melody?.motifRecurrence, ctx.primitives.melody?.phraseRegularity);
    const paired = role != null && instrument != null && role >= 0.55 && instrument >= 0.55;
    const recurring = recurrence != null && recurrence >= 0.55;
    if (!(likelihood >= 0.7 && recurring) && !(paired && recurring)) return null;
    return relation({
      relationId: "melody.call_response",
      relationType: "RESPONSE",
      subjectConceptId: "call",
      objectConceptId: "response",
      confidence: Math.min(likelihood || Math.min(role, instrument), recurrence),
      anchors: ["primitives.melody.callResponseLikelihood", "primitives.melody.motifRecurrence",
        "primitives.role.callResponse"],
      category: "performance"
    });
  }

  function followHarmony(ctx) {
    const follow = num(ctx.primitives.bass?.rootFollowing, ctx.performance.rootFollowing);
    const bassPresent = (ctx.bass?.confidence || 0) >= 0.5 || num(ctx.primitives.bass?.bassPresence) >= 0.55;
    const harmony = num(ctx.primitives.harmony?.tonalCenter, ctx.primitives.harmony?.keyConfidence,
      ctx.character.harmony?.tonalness);
    if (follow == null || follow < 0.65 || !bassPresent || harmony == null || harmony < 0.5) return null;
    return relation({
      relationId: "bass.follow_harmony",
      relationType: "FOLLOW",
      subjectConceptId: "bass",
      objectConceptId: "harmony",
      confidence: Math.min(follow, harmony),
      anchors: ["primitives.bass.rootFollowing", "primitives.harmony.tonalCenter"],
      category: "performance"
    });
  }

  function leadOverAccompaniment(ctx) {
    const lead = num(ctx.performance.leadLikelihood, ctx.primitives.role?.leadPresence);
    const accompaniment = num(ctx.primitives.role?.accompanimentDensity);
    if (lead == null || lead < 0.65 || !ctx.performance.leadInstrument) return null;
    if (accompaniment == null || accompaniment < 0.4) return null;
    return relation({
      relationId: "lead.over_accompaniment",
      relationType: "LEAD",
      subjectConceptId: "lead",
      objectConceptId: "accompaniment",
      confidence: Math.min(lead, clamp(0.55 + accompaniment * 0.4)),
      anchors: ["performance.leadLikelihood", "primitives.role.accompanimentDensity"],
      category: "performance"
    });
  }

  function exchangeLeads(ctx) {
    const rate = num(ctx.primitives.role?.leadTransitionRate, ctx.state.instrumentation?.leadTransitionRate);
    const change = num(ctx.primitives.arrangement?.foregroundChange, ctx.primitives.form?.foregroundChange);
    if (rate == null || change == null || rate < 0.28 || change < 0.55) return null;
    return relation({
      relationId: "lead.exchange",
      relationType: "EXCHANGE",
      subjectConceptId: "lead",
      objectConceptId: "lead",
      confidence: Math.min(rate + 0.4, change),
      anchors: ["primitives.role.leadTransitionRate", "primitives.arrangement.foregroundChange"],
      category: "arrangement"
    });
  }

  function buildArrangement(ctx) {
    const densityDelta = num(ctx.form.densityDelta, ctx.arrangement.densityDelta);
    const energy = num(ctx.expression.deltaEnergy, ctx.expression.flux);
    const layers = num(ctx.form.layerEntry, ctx.arrangement.layerEntry, ctx.form.buildupSlope,
      ctx.arrangement.buildLikelihood);
    if (densityDelta == null || energy == null || layers == null) return null;
    if (densityDelta < 0.18 || energy < 0.12 || layers < 0.4) return null;
    return relation({
      relationId: "arrangement.build",
      relationType: "BUILD",
      subjectConceptId: "arrangement",
      objectConceptId: "density",
      confidence: clamp(0.55 + densityDelta + energy * 0.3),
      anchors: ["primitives.form.densityDelta", "expressionFeatures.deltaEnergy", "primitives.form.layerEntry"],
      category: "arrangement",
      temporalScope: "TRANSIENT"
    });
  }

  function thinArrangement(ctx) {
    const densityDelta = num(ctx.form.densityDelta, ctx.arrangement.densityDelta);
    const bassEnergy = num(ctx.expression.deltaBass, ctx.primitives.production?.lowEndWeight,
      ctx.character.production?.subWeight);
    const bassFalling = num(ctx.expression.deltaBass) != null ? ctx.expression.deltaBass <= -0.08
      : bassEnergy != null && bassEnergy <= 0.4;
    const layersFalling = num(ctx.form.layerExit, ctx.arrangement.layerExit) >= 0.45
      || num(ctx.form.layerCount, ctx.arrangement.layerCount, ctx.character.texture?.layeredness) <= 0.35;
    if (densityDelta == null || densityDelta > -0.18 || !bassFalling || !layersFalling) return null;
    return relation({
      relationId: "arrangement.thinning",
      relationType: "THIN",
      subjectConceptId: "arrangement",
      objectConceptId: "bass",
      confidence: clamp(0.55 - densityDelta),
      anchors: ["primitives.form.densityDelta", "trackCharacter.production.subWeight", "primitives.form.layerExit"],
      category: "arrangement",
      temporalScope: "TRANSIENT"
    });
  }

  function densePercussion(ctx) {
    const onset = num(ctx.primitives.pulse?.onsetDensity, ctx.character.rhythm?.onsetDensity);
    const rising = num(ctx.expression.deltaTransientDensity, ctx.form.densityDelta);
    if (onset == null || rising == null || onset < 0.62 || rising < 0.12) return null;
    return relation({
      relationId: "percussion.densifying",
      relationType: "DENSE",
      subjectConceptId: "drums",
      objectConceptId: "pulse",
      confidence: clamp(onset * 0.55 + rising + 0.2),
      anchors: ["primitives.pulse.onsetDensity", "expressionFeatures.deltaTransientDensity"],
      category: "rhythm",
      temporalScope: "TRANSIENT"
    });
  }

  function openAfterTransition(ctx) {
    const change = num(ctx.form.sectionChange, ctx.form.transitionLikelihood, ctx.arrangement.transitionLikelihood);
    const densityDelta = num(ctx.form.densityDelta, ctx.arrangement.densityDelta);
    const space = num(ctx.primitives.production?.stereoWidth, ctx.production.stereoWidth,
      ctx.character.space?.spaciousness);
    if (change == null || densityDelta == null || space == null) return null;
    if (change < 0.6 || densityDelta < 0.16 || space < 0.55) return null;
    return relation({
      relationId: "arrangement.open_after_transition",
      relationType: "OPEN",
      subjectConceptId: "form",
      objectConceptId: "texture",
      confidence: clamp(Math.min(change, densityDelta + 0.5, space)),
      anchors: ["primitives.form.sectionChange", "primitives.form.densityDelta", "primitives.production.stereoWidth"],
      category: "arrangement",
      temporalScope: "TRANSIENT"
    });
  }

  function closeAfterTransition(ctx) {
    const change = num(ctx.form.sectionChange, ctx.form.transitionLikelihood);
    const densityDelta = num(ctx.form.densityDelta, ctx.arrangement.densityDelta);
    if (change == null || densityDelta == null || change < 0.6 || densityDelta > -0.16) return null;
    return relation({
      relationId: "arrangement.close_after_transition",
      relationType: "CLOSE",
      subjectConceptId: "form",
      objectConceptId: "texture",
      confidence: clamp(Math.min(change, 0.55 - densityDelta)),
      anchors: ["primitives.form.sectionChange", "primitives.form.densityDelta", "trackCharacter.texture.density"],
      category: "arrangement",
      temporalScope: "TRANSIENT"
    });
  }

  function pumpSidechain(ctx) {
    const pump = num(ctx.production.sidechain, ctx.primitives.production?.pumpingLikelihood,
      ctx.character.dynamics?.pumping);
    const kick = num(ctx.grammar.fourOnFloor, ctx.primitives.pulse?.kickPeriodicity, ctx.grammar.kickPeriodicity);
    if (pump == null || kick == null || pump < 0.7 || kick < 0.55) return null;
    return relation({
      relationId: "production.sidechain.pump",
      relationType: "PUMP",
      subjectConceptId: "low_end",
      objectConceptId: "kick",
      confidence: Math.min(pump, clamp(0.55 + kick * 0.4)),
      anchors: ["productionEvidence.sidechain", "rhythmicGrammar.fourOnFloor"],
      category: "production"
    });
  }

  function filterWithDensity(ctx) {
    const filter = num(ctx.production.filterSweep, ctx.primitives.production?.filterMotion);
    const densityDelta = num(ctx.form.densityDelta, ctx.arrangement.densityDelta, ctx.expression.deltaEnergy);
    if (filter == null || densityDelta == null || filter < 0.62 || densityDelta < 0.12) return null;
    return relation({
      relationId: "production.filter.with_density",
      relationType: "FILTER",
      subjectConceptId: "filter",
      objectConceptId: "density",
      confidence: clamp(filter * 0.6 + densityDelta + 0.2),
      anchors: ["productionEvidence.filterSweep", "primitives.form.densityDelta"],
      category: "production",
      temporalScope: "TRANSIENT"
    });
  }

  function spaceField(ctx) {
    const reverb = num(ctx.production.reverb, ctx.primitives.production?.reverbTail, ctx.primitives.production?.roomSize);
    const stereo = num(ctx.production.stereoWidth, ctx.primitives.production?.stereoWidth,
      ctx.character.space?.spaciousness);
    if (reverb == null || stereo == null || reverb < 0.62 || stereo < 0.62) return null;
    return relation({
      relationId: "production.space.field",
      relationType: "SPACE",
      subjectConceptId: "reverb",
      objectConceptId: "stereo",
      confidence: Math.min(reverb, stereo),
      anchors: ["productionEvidence.reverb", "productionEvidence.stereoWidth"],
      category: "production",
      minAxes: 1
    });
  }

  function sectionTransition(ctx) {
    const change = num(ctx.form.sectionChange, ctx.form.transitionLikelihood, ctx.arrangement.transitionLikelihood);
    if (change == null || change < 0.65) return null;
    return relation({
      relationId: "form.section_transition",
      relationType: "TRANSITION",
      subjectConceptId: "form",
      objectConceptId: "section",
      confidence: change,
      anchors: ["primitives.form.sectionChange", "primitives.form.transitionLikelihood"],
      category: "live",
      temporalScope: "TRANSIENT",
      minAxes: 1
    });
  }

  return { evaluate, TYPES, relation, sufficient, context, read };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MaterialRelationEngine;
