// Deterministic musical concepts between low-level DSP and language.
// A field is populated only when an existing detector can support it; otherwise it remains null
// and meta[path].available is false. This is an honest capability contract, not a genre guess.
const MusicalPrimitives = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const valueOrNull = value => finite(value) ? value : null;
  const tempoClass = bpm => !finite(bpm) || bpm <= 0 ? null
    : bpm < 70 ? "very_slow" : bpm < 96 ? "slow" : bpm < 126 ? "moderate" : bpm < 156 ? "fast" : "very_fast";
  const pitchBreadth = (chroma, focus) => {
    if (!Array.isArray(chroma) || chroma.length !== 12 || !finite(focus) || focus < 0.16) return null;
    const maximum = Math.max(...chroma);
    return chroma.filter(value => value >= maximum * 0.34).length;
  };
  const confidenceOf = (...values) => {
    const usable = values.filter(finite).map(clamp);
    return usable.length ? Math.min(...usable) : null;
  };
  const putMeta = (meta, path, value, confidence, anchors, method = "derived") => {
    meta[path] = { available: value !== null && value !== undefined,
      confidence: value !== null && value !== undefined && finite(confidence) ? clamp(confidence) : null,
      anchors: Array.isArray(anchors) ? anchors : [], method };
  };
  const register = (output, group, confidence, anchors, method) => {
    for (const [key, value] of Object.entries(output[group]))
      putMeta(output.meta, `${group}.${key}`, value, confidence, anchors, method);
  };

  function empty() {
    return {
      pulse: {
        tempo: null, tempoStability: null, tempoClass: null, halfTimeLikelihood: null,
        doubleTimeLikelihood: null, pulsePresence: null, pulseRegularity: null, subdivision: null,
        subdivisionRatio: null, swingRatio: null, shuffleStrength: null, syncopation: null,
        accentPeriodicity: null, accentPlacement: null, accentDisplacement: null,
        microTimingDeviation: null, metricStability: null, grooveStability: null, groovePushPull: null,
        onsetDensity: null, densityPerPulse: null, rhythmicEntropy: null, breakDensity: null,
        kickPeriodicity: null, snarePeriodicity: null, offbeatActivity: null, ghostNoteLikelihood: null,
        rhythmicRepetition: null, rhythmicVariation: null
      },
      harmony: {
        tonalCenter: null, keyConfidence: null, majorMinorLikelihood: null, modality: null,
        modeConfidence: null, chordChangeRate: null, harmonicRhythm: null, harmonicStability: null,
        harmonicTension: null, chromaticity: null, modalMixture: null, modalLikelihood: null,
        modalAmbiguity: null, majorMinorDeviation: null, pedalToneLikelihood: null, cadenceStrength: null,
        harmonicRepetition: null, harmonicMotionDirection: null, bassMotion: null,
        harmonicDensity: null, tonalAmbiguity: null
      },
      melody: {
        melodicContour: null, melodicRange: null, averageInterval: null, intervalVariance: null,
        stepwiseMotion: null, leapLikelihood: null, motifStrength: null, motifRecurrence: null,
        phraseLength: null, phraseRegularity: null, sequenceLikelihood: null, ornamentDensity: null,
        callResponseLikelihood: null, melodicRepetition: null, melodicDirection: null, melodicDensity: null,
        contourSlope: null
      },
      bass: {
        bassPresence: null, bassActivity: null, bassRegister: null, bassRhythmicRole: null,
        bassMelodicRole: null, melodicBassLikelihood: null, rootFollowing: null, walkingLikelihood: null,
        ostinatoLikelihood: null, syncopation: null, repetition: null, articulation: null,
        bassMotion: null, bassKickInteraction: null
      },
      texture: {
        voiceCount: null, dominanceDispersion: null, textureClass: null, sustainRatio: null,
        onsetAlignment: null, registerSpread: null
      },
      role: {
        leadPresence: null, leadStability: null, leadTransitionRate: null, accompanimentDensity: null,
        bassFunction: null, foundationLayer: null, foregroundInstrument: null,
        foregroundLikelihood: null, harmonicRole: null, melodicRole: null, rhythmicRole: null,
        compingLikelihood: null, callResponse: null, ensembleDensity: null
      },
      instrument: {
        presenceConfidence: null, dominanceConfidence: null, entryLikelihood: null, exitLikelihood: null,
        soloLikelihood: null, compingLikelihood: null, rhythmicRole: null, harmonicRole: null,
        melodicRole: null, foregroundBackground: null, callResponse: null, ensembleDensity: null,
        articulation: null, staccato: null, legato: null, vibrato: null, humanization: null,
        expressiveTiming: null
      },
      tonal: {
        tonalFocus: null, harmonicRhythm: null, pitchSetBreadth: null, melodicContourRange: null,
        ornamentDensity: null, microtonalActivity: null, drone: null
      },
      articulation: {
        attackSharpness: null, transientSoftness: null, noteLengthRatio: null,
        dynamicAccentRange: null, staccatoLikelihood: null, legatoLikelihood: null,
        vibratoLikelihood: null, humanization: null, expressiveTiming: null
      },
      form: {
        repetitionDepth: null, sectionNovelty: null, sectionChange: null, buildupSlope: null,
        releaseDepth: null, dropLikelihood: null, transitionLikelihood: null, cyclicLength: null,
        density: null, densityDelta: null, layerCount: null, layerEntry: null, layerExit: null,
        variation: null, foregroundChange: null, instrumentRoleChange: null, energyTrajectory: null
      },
      production: {
        brightness: null, warmth: null, roughness: null, noisiness: null, harmonicity: null,
        spectralSlope: null, spectralTilt: null, spectralFlux: null, transientSharpness: null,
        transientSoftness: null, lowEndWeight: null, airiness: null, stereoWidth: null,
        monoFocus: null, compressionLikelihood: null, compressionBehavior: null,
        pumpingLikelihood: null, periodicDucking: null, saturationLikelihood: null,
        saturationAmount: null, distortionLikelihood: null, reverbTail: null, roomSize: null,
        delayDensity: null, filterMotion: null, lowPassLikelihood: null, highPassLikelihood: null,
        granularity: null, sampleRepetition: null, sampleBasedLikelihood: null, spatialDepth: null
      },
      arrangement: {
        density: null, densityDelta: null, layerCount: null, layerEntry: null, layerExit: null,
        buildLikelihood: null, breakdownLikelihood: null, dropLikelihood: null,
        transitionLikelihood: null, repetition: null, variation: null, foregroundChange: null,
        instrumentRoleChange: null, energyTrajectory: null, verifiedEnsembleSize: null
      },
      meta: {}
    };
  }

  function analyze(context = {}) {
    const output = empty();
    const rhythm = context.rhythm || context.audio || {};
    const grammar = context.rhythmicGrammar || {};
    const character = context.trackCharacter || {};
    const instrumentation = context.instrumentation || {};
    const performance = context.performance || {};
    const arrangement = context.arrangement || {};
    const expression = context.expressionFeatures || {};
    const productionEvidence = context.productionEvidence || {};
    const mir = context.mir || {};
    // A measured harmony or melody window is evidence in its own right. Leaving those two out of
    // this gate meant a chroma/pitch-only context returned an entirely empty primitive set.
    const hasEvidence = Object.keys(rhythm).length || Object.keys(character).length ||
      (instrumentation.observed || []).length || Object.keys(grammar).length || Object.keys(mir).length ||
      context.harmonicMotion?.reason === "measured" || context.pitchEvidence?.reason === "measured";
    if (!hasEvidence) {
      for (const group of Object.keys(output).filter(key => key !== "meta")) register(output, group, null, [], "unavailable");
      return output;
    }

    const bpm = valueOrNull(mir.tempo?.bpm ?? rhythm.bpm ?? character.rhythm?.bpm);
    const beatConfidence = valueOrNull(mir.tempo?.confidence ?? rhythm.beatConfidence ?? rhythm.confidence);
    const tempoStability = valueOrNull(mir.tempo?.stability ?? rhythm.tempoStability ?? character.rhythm?.pulseRegularity);
    const pulsePresence = beatConfidence === null ? null
      : clamp(beatConfidence * 0.72 + (character.rhythm?.pulseRegularity || 0) * 0.28);
    const subdivisionRatio = valueOrNull(grammar.subdivisionRatio);
    const swing = valueOrNull(grammar.swing);
    const repetition = valueOrNull(character.structure?.repetition);
    const rhythmicComplexity = valueOrNull(character.rhythm?.rhythmicComplexity);
    Object.assign(output.pulse, {
      tempo: bpm, tempoStability, tempoClass: tempoClass(bpm), pulsePresence,
      pulseRegularity: valueOrNull(character.rhythm?.pulseRegularity ?? tempoStability),
      subdivision: subdivisionRatio === null ? null : subdivisionRatio > 1.35 ? "uneven" : "straight",
      subdivisionRatio, swingRatio: subdivisionRatio, shuffleStrength: swing,
      syncopation: valueOrNull(grammar.syncopation),
      accentPeriodicity: Number.isInteger(grammar.accentPeriodicity) ? grammar.accentPeriodicity : null,
      accentPlacement: valueOrNull(grammar.accentPlacement), accentDisplacement: valueOrNull(grammar.accentPlacement),
      metricStability: tempoStability,
      grooveStability: confidenceOf(tempoStability, character.rhythm?.pulseRegularity),
      groovePushPull: valueOrNull(grammar.groovePushPull), microTimingDeviation: valueOrNull(grammar.microTimingDeviation),
      halfTimeLikelihood: valueOrNull(grammar.halfTimeLikelihood), doubleTimeLikelihood: valueOrNull(grammar.doubleTimeLikelihood),
      onsetDensity: valueOrNull(character.rhythm?.onsetDensity ?? (finite(rhythm.onsetRate) ? clamp(rhythm.onsetRate / 4.2) : null)),
      densityPerPulse: finite(rhythm.onsetRate) && finite(bpm) && bpm > 0 ? rhythm.onsetRate / (bpm / 60) : null,
      // A real onset-interval entropy when the grammar computed one from actual events; otherwise
      // fall back to the upstream ML complexity estimate rather than leaving a hole.
      rhythmicEntropy: valueOrNull(grammar.rhythmicEntropy ?? rhythmicComplexity),
      breakDensity: valueOrNull(character.rhythm?.breakbeatLikelihood),
      kickPeriodicity: valueOrNull(grammar.kickPeriodicity ?? grammar.fourOnFloor), offbeatActivity: valueOrNull(grammar.syncopation),
      rhythmicRepetition: repetition, rhythmicVariation: repetition === null ? null : clamp(1 - repetition)
    });
    register(output, "pulse", confidenceOf(beatConfidence, grammar.confidence ?? beatConfidence),
      ["mir.tempo", "rhythmicGrammar", "trackCharacter.rhythm"], "beat/onset aggregation");

    const observed = instrumentation.observed || [];
    const families = instrumentation.families || {};
    const familyVoices = Object.values(families).filter(item => item?.confidence >= 0.35);
    const voiceCount = observed.length ? Math.max(1, familyVoices.length || observed.filter(x => x.confidence >= 0.35).length) : null;
    const dispersion = valueOrNull(instrumentation.dominanceDispersion);
    const sustain = valueOrNull(character.texture?.sustainedness);
    let textureClass = context.textureSignals?.textureClass || null;
    if (!textureClass && voiceCount === 1) textureClass = "monophonic";
    else if (!textureClass && voiceCount >= 3 && dispersion >= 0.6 && sustain >= 0.72) textureClass = "layered";
    else if (!textureClass && voiceCount >= 3 && dispersion >= 0.6) textureClass = "polyphonic";
    else if (!textureClass && voiceCount >= 2) textureClass = "homophonic";
    Object.assign(output.texture, { voiceCount, dominanceDispersion: dispersion, textureClass,
      sustainRatio: sustain, onsetAlignment: valueOrNull(context.textureSignals?.onsetAlignment),
      registerSpread: valueOrNull(context.textureSignals?.registerSpread) });
    register(output, "texture", instrumentation.confidence,
      ["instrumentation", "trackCharacter.texture"], "instrument-family rollup");

    const top = observed[0];
    const leadPresence = top ? clamp((top.confidence || 0) * 0.65 + (1 - (dispersion ?? 0.5)) * 0.35) : null;
    const transitionRate = valueOrNull(instrumentation.leadTransitionRate);
    const bassFamily = families.bass?.confidence;
    Object.assign(output.role, {
      leadPresence, leadStability: transitionRate === null ? null : clamp(1 - transitionRate / 0.5),
      leadTransitionRate: transitionRate,
      accompanimentDensity: valueOrNull(arrangement.density ?? character.texture?.density),
      bassFunction: performance.bassFunction || null,
      foundationLayer: finite(bassFamily) ? clamp(bassFamily * 0.72 + (character.production?.subWeight || 0) * 0.28) : null,
      foregroundInstrument: performance.foregroundInstrument || null,
      foregroundLikelihood: valueOrNull(performance.foregroundLikelihood),
      melodicRole: valueOrNull(performance.leadLikelihood),
      callResponse: transitionRate === null ? null : clamp(transitionRate / 0.5),
      // Comping is chordal accompaniment: offbeat-leaning attacks that stay behind the lead
      // rather than becoming it. Derived (section 3-B) from three values that are already real --
      // syncopation, how evenly dominance is shared, and how sustained the texture is -- so the
      // idiom that names it is no longer waiting for a detector that nothing produces.
      compingLikelihood: valueOrNull(performance.compingLikelihood) ?? (
        output.pulse.syncopation === null || dispersion === null || sustain === null ? null
          : clamp(output.pulse.syncopation * 0.45 + dispersion * 0.3 + (1 - Math.abs(sustain - 0.5) * 2) * 0.25)),
      ensembleDensity: valueOrNull(arrangement.density ?? character.texture?.density)
    });
    register(output, "role", instrumentation.confidence,
      ["instrumentation", "performance", "arrangement"], "instrument history");

    // harmonicMotion is the chroma-SEQUENCE detector (js/mir/harmonicMotionEngine). It reports
    // `reason: "measured"` only when the window really had enough tonal frames, so everything
    // downstream can treat that flag as permission to speak about harmony at all.
    const motion = context.harmonicMotion || {};
    const motionMeasured = motion.reason === "measured";
    const tonalFocus = valueOrNull(context.audio?.tonalFocus ?? character.harmony?.tonalness);
    const harmonicMotion = valueOrNull(character.harmony?.harmonicMotion);
    const chroma = context.audio?.chroma || mir.chroma?.vector;
    const breadth = pitchBreadth(chroma, tonalFocus);
    const tonal = mir.tonal || {};
    Object.assign(output.tonal, {
      tonalFocus, harmonicRhythm: harmonicMotion,
      // How many pitch classes are actually sounding. The averaged chroma vector gives this
      // directly when present; otherwise the harmonic-motion detector already counted them over
      // its whole window, which is the more stable of the two measurements.
      pitchSetBreadth: breadth ?? (motionMeasured && finite(motion.pitchClassCount) ? motion.pitchClassCount : null),
      melodicContourRange: valueOrNull(context.pitchEvidence?.melodicContourRange),
      ornamentDensity: valueOrNull(context.pitchEvidence?.ornamentDensity),
      microtonalActivity: valueOrNull(context.pitchEvidence?.microtonalActivity),
      drone: tonalFocus !== null && sustain !== null && harmonicMotion !== null
        ? clamp(tonalFocus * sustain * (1 - harmonicMotion)) : null
    });
    register(output, "tonal", confidenceOf(tonalFocus, tonal.confidence ?? tonalFocus),
      ["audio.chroma", "mir.tonal", "trackCharacter.harmony"], "chroma/MIR");
    if (breadth === null && motionMeasured && finite(motion.pitchClassCount))
      putMeta(output.meta, "tonal.pitchSetBreadth", output.tonal.pitchSetBreadth, motion.confidence,
        ["audio.chroma", "harmonicMotion"], "chroma-sequence pitch-class count");

    const tonalAmbiguity = tonalFocus === null ? null : clamp(1 - tonalFocus);
    const chromaticity = valueOrNull(character.harmony?.chromaEntropy);
    // When the chroma-sequence detector has enough tonal frames it OWNS the harmonic-rhythm and
    // modality fields, because it measures them directly; otherwise they stay null rather than
    // borrowing a nearby number.
    const majorMinor = motionMeasured && motion.majorMinorLikelihood ? motion.majorMinorLikelihood
      : tonal.uncertain || !tonal.scale ? null : {
        major: tonal.scale === "major" ? clamp(tonal.confidence) : clamp(1 - tonal.confidence),
        minor: tonal.scale === "minor" ? clamp(tonal.confidence) : clamp(1 - tonal.confidence)
      };
    const sequenceCenter = motionMeasured && motion.tonalCenter && motion.keyUncertain !== true
      ? motion.tonalCenter : null;
    const sequenceKeyConfidence = sequenceCenter ? valueOrNull(motion.keyConfidence) : null;
    Object.assign(output.harmony, {
      tonalCenter: sequenceCenter || (!motionMeasured && !tonal.uncertain && tonal.key ? tonal.key : null),
      keyConfidence: sequenceKeyConfidence ?? (!motionMeasured && !tonal.uncertain ? valueOrNull(tonal.confidence) : null),
      majorMinorLikelihood: majorMinor,
      modality: motionMeasured ? motion.modality || null : null,
      modeConfidence: motionMeasured ? valueOrNull(motion.modeConfidence) : null,
      modalLikelihood: motionMeasured ? valueOrNull(motion.modalLikelihood) : null,
      modalAmbiguity: motionMeasured ? valueOrNull(motion.modalAmbiguity) : null,
      majorMinorDeviation: motionMeasured ? valueOrNull(motion.majorMinorDeviation) : null,
      chordChangeRate: valueOrNull(motion.chordChangeRate),
      harmonicRhythm: valueOrNull(motion.harmonicRhythm) ?? harmonicMotion,
      harmonicStability: valueOrNull(motion.harmonicStability),
      cadenceStrength: valueOrNull(motion.cadenceStrength),
      harmonicMotionDirection: valueOrNull(motion.harmonicMotionDirection),
      harmonicTension: valueOrNull(context.moodDimensions?.tension), chromaticity,
      pedalToneLikelihood: output.tonal.drone,
      harmonicRepetition: valueOrNull(motion.harmonicRepetition) ??
        (repetition !== null && harmonicMotion !== null ? clamp(repetition * (1 - harmonicMotion * 0.5)) : null),
      bassMotion: valueOrNull(performance.bassPitchMotion),
      harmonicDensity: valueOrNull(motion.harmonicDensity) ?? (breadth === null ? null : clamp(breadth / 12)),
      tonalAmbiguity
    });
    register(output, "harmony", confidenceOf(tonal.confidence ?? tonalFocus, character.confidence),
      ["mir.tonal", "audio.chroma", "trackCharacter.harmony", "moodDimensions.tension"], "MIR/temporal harmony");
    // The chroma-motion fields carry the detector's OWN confidence, not the group average: a
    // window can be tonally clear enough to time chord changes while its key estimate is not.
    if (motionMeasured) {
      for (const key of ["chordChangeRate", "harmonicRhythm", "harmonicStability", "harmonicRepetition",
        "harmonicMotionDirection", "harmonicDensity", "cadenceStrength", "modality", "modeConfidence",
        "modalLikelihood", "modalAmbiguity", "majorMinorDeviation", "majorMinorLikelihood",
        "tonalCenter", "keyConfidence"]) {
        putMeta(output.meta, `harmony.${key}`, output.harmony[key],
          key === "tonalCenter" || key === "keyConfidence" ? motion.keyConfidence ?? motion.confidence
            : key.startsWith("mod") || key.startsWith("major") ? motion.modeConfidence : motion.confidence,
          ["audio.chroma", "harmonicMotion"],
          key === "tonalCenter" || key === "keyConfidence" ? "chroma-sequence key" : "chroma-sequence motion");
      }
    }

    // pitchEvidence is the predominant-pitch contour detector (js/mir/melodyContourEngine); it
    // reports `reason: "measured"` only when a clear enough note sequence really existed.
    const pitch = context.pitchEvidence || {};
    const pitchMeasured = pitch.reason === "measured";
    const motif = valueOrNull(pitch.motifRecurrence);
    Object.assign(output.melody, {
      melodicContour: pitch.melodicContour || null,
      melodicRange: valueOrNull(pitch.melodicRange ?? pitch.melodicContourRange),
      averageInterval: valueOrNull(pitch.averageInterval),
      intervalVariance: valueOrNull(pitch.intervalVariance),
      stepwiseMotion: valueOrNull(pitch.stepwiseMotion),
      leapLikelihood: valueOrNull(pitch.leapLikelihood),
      motifStrength: valueOrNull(pitch.motifStrength) ?? motif, motifRecurrence: motif,
      phraseLength: valueOrNull(pitch.phraseLength),
      phraseRegularity: valueOrNull(pitch.phraseRegularity),
      sequenceLikelihood: valueOrNull(pitch.sequenceLikelihood),
      ornamentDensity: valueOrNull(pitch.ornamentDensity),
      // A measured phrase alternation beats the instrument-history proxy: role.callResponse only
      // knows that the lead changed hands, not that phrases answer each other.
      callResponseLikelihood: valueOrNull(pitch.callResponseLikelihood) ?? output.role.callResponse,
      melodicRepetition: valueOrNull(pitch.melodicRepetition) ?? motif,
      melodicDirection: pitch.melodicDirection || null,
      melodicDensity: valueOrNull(pitch.melodicDensity) ?? valueOrNull(performance.melodicActivity),
      contourSlope: valueOrNull(pitch.contourSlope)
    });
    register(output, "melody", confidenceOf(performance.pitchActivity, performance.melodicActivity),
      ["pitchEvidence", "performance", "instrumentation"], "pitch tracker when available");
    if (pitchMeasured) {
      for (const key of ["melodicContour", "melodicDirection", "melodicRange", "averageInterval",
        "intervalVariance", "stepwiseMotion", "leapLikelihood", "motifStrength", "motifRecurrence",
        "melodicRepetition", "sequenceLikelihood", "phraseLength", "phraseRegularity",
        "callResponseLikelihood", "melodicDensity", "contourSlope"]) {
        putMeta(output.meta, `melody.${key}`, output.melody[key], pitch.confidence,
          ["pitchEvidence.trajectory"], "predominant-pitch contour");
      }
      output.tonal.melodicContourRange = valueOrNull(pitch.melodicContourRange ?? pitch.melodicRange);
      putMeta(output.meta, "tonal.melodicContourRange", output.tonal.melodicContourRange, pitch.confidence,
        ["pitchEvidence.trajectory"], "predominant-pitch contour");
    }

    const bassPresence = valueOrNull(families.bass?.confidence);
    const bassMotionValue = valueOrNull(performance.bassPitchMotion);
    const bassRepetition = valueOrNull(performance.bassPatternRepetition);
    const keyPitchClass = motionMeasured && Number.isInteger(motion.keyPitchClass) && motion.keyUncertain !== true
      ? motion.keyPitchClass
      : (!motionMeasured && Number.isInteger(tonal.pitchClass) && !tonal.uncertain ? tonal.pitchClass : null);
    const histogramRoot = (() => {
      const histogram = performance.bassPitchClassHistogram;
      if (!Array.isArray(histogram) || histogram.length !== 12 || !Number.isInteger(keyPitchClass)) return null;
      const total = histogram.reduce((sum, value) => sum + (Number(value) || 0), 0);
      if (total < 6) return null;
      const tonic = Number(histogram[keyPitchClass]) || 0;
      const fifth = Number(histogram[(keyPitchClass + 7) % 12]) || 0;
      const third = Math.max(Number(histogram[(keyPitchClass + 4) % 12]) || 0, Number(histogram[(keyPitchClass + 3) % 12]) || 0);
      return clamp((tonic + fifth + third) / total);
    })();
    // Section 7. rootFollowing relates the bass pitch proxy to the harmonic state, so it can only
    // be claimed when BOTH sides are real: a bass line with no measured harmony to follow, or a
    // harmony estimate with no clear bass, leaves it null instead of asserting a root anchor.
    const rootFollowing = valueOrNull(performance.rootFollowing) ?? histogramRoot ?? (
      bassMotionValue !== null && motionMeasured && finite(motion.harmonicStability) && finite(motion.confidence) &&
        motion.confidence >= 0.4 && bassPresence !== null && bassPresence >= 0.45
        ? clamp((1 - bassMotionValue) * 0.55 + motion.harmonicStability * 0.45) : null);
    Object.assign(output.bass, {
      bassPresence,
      bassActivity: bassPresence === null ? null
        : clamp(bassPresence * 0.5 + (bassMotionValue ?? 0) * 0.3 + (output.pulse.onsetDensity ?? 0) * 0.2),
      bassRegister: bassPresence === null ? null : "low",
      bassRhythmicRole: performance.bassFunction || null,
      bassMelodicRole: performance.bassFunction === "melodic" || performance.bassFunction === "walking" ? performance.bassFunction : null,
      // A melodic bass moves a lot without simply repeating one cell; a static or ostinato bass
      // scores low even when it is loud.
      melodicBassLikelihood: bassMotionValue === null || bassPresence === null ? null
        : clamp(bassMotionValue * (1 - (bassRepetition ?? 0) * 0.6) * clamp(bassPresence * 1.4)),
      rootFollowing, walkingLikelihood: valueOrNull(performance.walkingBassLikelihood),
      ostinatoLikelihood: performance.bassFunction === "ostinato" ? valueOrNull(performance.bassPatternRepetition ?? 0.7)
        : bassRepetition !== null && bassMotionValue !== null ? clamp(bassRepetition * (1 - bassMotionValue * 0.5)) : null,
      syncopation: valueOrNull(performance.bassSyncopation), repetition: bassRepetition,
      articulation: performance.bassArticulation || null, bassMotion: bassMotionValue,
      bassKickInteraction: valueOrNull(performance.bassKickInteraction)
    });
    register(output, "bass", confidenceOf(bassPresence, instrumentation.confidence),
      ["instrumentation.families.bass", "performance"], "bass-specific pitch/onset tracker");

    const attack = valueOrNull(character.timbre?.transientSharpness);
    Object.assign(output.articulation, {
      attackSharpness: attack, transientSoftness: attack === null ? null : clamp(1 - attack), noteLengthRatio: sustain,
      dynamicAccentRange: valueOrNull(character.dynamics?.dynamicRange),
      staccatoLikelihood: attack !== null && sustain !== null ? clamp(attack * (1 - sustain)) : null,
      legatoLikelihood: attack !== null && sustain !== null ? clamp(sustain * (1 - attack * 0.45)) : null,
      vibratoLikelihood: valueOrNull(context.pitchEvidence?.vibratoLikelihood),
      humanization: valueOrNull(context.timingEvidence?.humanization),
      expressiveTiming: valueOrNull(context.timingEvidence?.expressiveTiming)
    });
    register(output, "articulation", character.confidence,
      ["trackCharacter.timbre", "trackCharacter.texture", "trackCharacter.dynamics"], "timbre envelope");

    const entranceConfidence = Math.max(0, ...((context.instrumentEvents || []).filter(event => event.kind === "entrance")
      .map(event => Number(event.confidence) || 0)));
    const exitConfidence = Math.max(0, ...((context.instrumentEvents || []).filter(event => event.kind === "exit")
      .map(event => Number(event.confidence) || 0)));
    Object.assign(output.instrument, {
      presenceConfidence: valueOrNull(top?.confidence), dominanceConfidence: valueOrNull(top?.dominance),
      entryLikelihood: entranceConfidence > 0 ? entranceConfidence : null,
      exitLikelihood: exitConfidence > 0 ? exitConfidence : null,
      soloLikelihood: valueOrNull(performance.soloLikelihood), compingLikelihood: valueOrNull(performance.compingLikelihood),
      rhythmicRole: performance.rhythmicRole || null, harmonicRole: performance.harmonicRole || null,
      melodicRole: performance.melodicRole || null,
      foregroundBackground: finite(performance.foregroundLikelihood)
        ? (performance.foregroundLikelihood >= .65 ? "foreground" : performance.foregroundLikelihood <= .35 ? "background" : null) : null,
      callResponse: output.role.callResponse, ensembleDensity: output.role.ensembleDensity,
      articulation: performance.articulation || null, staccato: output.articulation.staccatoLikelihood,
      legato: output.articulation.legatoLikelihood, vibrato: output.articulation.vibratoLikelihood,
      humanization: output.articulation.humanization, expressiveTiming: output.articulation.expressiveTiming
    });
    register(output, "instrument", confidenceOf(top?.confidence, character.confidence),
      ["instrumentation", "instrumentEvents", "performance", "trackCharacter"], "presence/dominance/event role fusion");

    const sectionNovelty = valueOrNull(context.novelty?.score ?? character.structure?.sectionNovelty);
    const density = valueOrNull(arrangement.density ?? character.texture?.density);
    const densityDelta = valueOrNull(expression.deltaTransientDensity ?? expression.deltaEnergy);
    const events = context.instrumentEvents || [];
    const entries = events.filter(event => event.kind === "entrance").length;
    const exits = events.filter(event => event.kind === "exit").length;
    const build = valueOrNull(character.structure?.buildupLikelihood);
    const breakdown = valueOrNull(character.structure?.breakdownLikelihood);
    const drop = valueOrNull(character.structure?.dropLikelihood ?? expression.dropScore);
    const transition = sectionNovelty === null ? null : clamp(sectionNovelty + Math.min(0.35, entries * 0.12 + exits * 0.12));
    Object.assign(output.form, {
      repetitionDepth: repetition, sectionNovelty,
      sectionChange: context.novelty?.transitionDetected === true ? 1 : sectionNovelty,
      buildupSlope: build, releaseDepth: breakdown, dropLikelihood: drop, transitionLikelihood: transition,
      cyclicLength: valueOrNull(context.structureEvidence?.cyclicLength), density, densityDelta, layerCount: voiceCount,
      layerEntry: entries ? clamp(entries / 3) : events.length ? 0 : null,
      layerExit: exits ? clamp(exits / 3) : events.length ? 0 : null,
      variation: repetition === null ? null : clamp(1 - repetition),
      foregroundChange: valueOrNull(performance.dominanceChange), instrumentRoleChange: transitionRate,
      energyTrajectory: valueOrNull(expression.deltaEnergy)
    });
    register(output, "form", character.confidence,
      ["trackCharacter.structure", "novelty", "instrumentEvents", "measurements"], "temporal state comparison");

    const low = valueOrNull(expression.bass ?? context.audio?.bass);
    const high = valueOrNull(expression.high ?? context.audio?.high);
    const brightness = valueOrNull(character.timbre?.brightness);
    const saturation = valueOrNull(character.production?.saturation);
    const compression = valueOrNull(character.dynamics?.compressionDensity);
    Object.assign(output.production, {
      brightness, warmth: valueOrNull(character.timbre?.warmth), roughness: valueOrNull(character.timbre?.roughness),
      noisiness: valueOrNull(character.timbre?.noisiness), harmonicity: tonalFocus,
      spectralSlope: low !== null && high !== null ? Math.max(-1, Math.min(1, low - high)) : null,
      spectralTilt: low !== null && high !== null ? Math.max(-1, Math.min(1, low - high)) : null,
      spectralFlux: valueOrNull(expression.flux ?? context.audio?.flux), transientSharpness: attack,
      transientSoftness: attack === null ? null : clamp(1 - attack),
      lowEndWeight: valueOrNull(character.production?.subWeight ?? low),
      airiness: high !== null && brightness !== null ? clamp(high * 0.55 + brightness * 0.45) : null,
      stereoWidth: valueOrNull(productionEvidence.stereoWidth),
      monoFocus: finite(productionEvidence.stereoWidth) ? clamp(1 - productionEvidence.stereoWidth) : null,
      compressionLikelihood: compression, compressionBehavior: compression,
      pumpingLikelihood: valueOrNull(productionEvidence.sidechain ?? character.dynamics?.pumping),
      periodicDucking: valueOrNull(productionEvidence.sidechain ?? character.dynamics?.pumping),
      saturationLikelihood: saturation, saturationAmount: saturation,
      distortionLikelihood: valueOrNull(productionEvidence.distortion), reverbTail: valueOrNull(productionEvidence.reverb),
      roomSize: valueOrNull(productionEvidence.roomSize), delayDensity: valueOrNull(productionEvidence.delayDensity),
      filterMotion: valueOrNull(productionEvidence.filterSweep), lowPassLikelihood: valueOrNull(productionEvidence.lowPass),
      highPassLikelihood: valueOrNull(productionEvidence.highPass), granularity: valueOrNull(character.texture?.granularness),
      sampleRepetition: repetition, sampleBasedLikelihood: valueOrNull(productionEvidence.sampleBased),
      spatialDepth: valueOrNull(character.space?.perceivedDepth)
    });
    register(output, "production", character.confidence,
      ["trackCharacter.production", "trackCharacter.timbre", "productionEvidence", "measurements"], "DSP/production evidence");

    Object.assign(output.arrangement, {
      density, densityDelta, layerCount: voiceCount, layerEntry: output.form.layerEntry, layerExit: output.form.layerExit,
      buildLikelihood: build, breakdownLikelihood: breakdown, dropLikelihood: drop, transitionLikelihood: transition,
      repetition, variation: output.form.variation, foregroundChange: output.form.foregroundChange,
      instrumentRoleChange: transitionRate, energyTrajectory: output.form.energyTrajectory,
      verifiedEnsembleSize: Number.isFinite(arrangement.verifiedEnsembleSize) ? arrangement.verifiedEnsembleSize : null
    });
    register(output, "arrangement", confidenceOf(character.confidence, instrumentation.confidence ?? character.confidence),
      ["arrangement", "instrumentation", "trackCharacter.structure", "measurements"], "arrangement/temporal aggregation");
    return output;
  }

  function schema() {
    const value = empty();
    return Object.fromEntries(Object.entries(value).filter(([group]) => group !== "meta")
      .map(([group, fields]) => [group, Object.keys(fields)]));
  }
  function capabilities(primitives = empty()) {
    return Object.entries(primitives.meta || {}).map(([path, meta]) => ({ path, ...meta }));
  }
  function reset() {}
  return { analyze, reset, empty, schema, capabilities };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MusicalPrimitives;
