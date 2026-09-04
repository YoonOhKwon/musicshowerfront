// Melodic contour / motion / motif / phrase detector (sections 5 and 6).
//
// Input is a predominant-pitch trajectory (see melodyPitchTracker): {at, semitone, clarity}
// samples. Exact note names are never claimed. What IS measurable from a trajectory is its shape,
// how far it moves per step, whether short shapes come back, and where it breathes -- which is
// exactly the vocabulary sections 5 and 6 ask for.
//
// Pure and synchronous so both the browser runtime and the tests drive the identical code path.
const MelodyContour = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  const MIN_NOTES = 8;
  // Below this mean clarity the trajectory is tracking noise or a percussive band, not a melody.
  const MIN_CLARITY = 0.1;
  // A step of 2.5 semitones or less is conjunct motion; 4+ is a leap. The gap between them is
  // deliberately left unclassified rather than forced into one bucket.
  const STEP_SEMITONES = 2.5;
  const LEAP_SEMITONES = 4;
  // Samples must hold the same pitch for at least this long to count as a note, and a gap this
  // long (silence or lost tracking) ends a phrase.
  const NOTE_HOLD_MS = 70;
  const PHRASE_GAP_MS = 420;
  // A silence long enough to be a re-articulation rather than a dropped analysis frame.
  const NOTE_GAP_MS = 110;
  const NOTE_TOLERANCE = 0.8;

  function nulls(reason) {
    return {
      melodicContour: null, melodicDirection: null, melodicRange: null, melodicDensity: null, contourSlope: null,
      averageInterval: null, intervalVariance: null, stepwiseMotion: null, leapLikelihood: null,
      motifStrength: null, motifRecurrence: null, melodicRepetition: null, sequenceLikelihood: null,
      phraseLength: null, phraseRegularity: null, callResponseLikelihood: null,
      melodicContourRange: null, noteCount: 0, phraseCount: 0, confidence: 0, reason
    };
  }

  // Groups consecutive samples that stay within NOTE_TOLERANCE into single notes, and marks where
  // a timing gap breaks the line into phrases.
  function segment(samples) {
    const notes = [];
    let current = null;
    let brokeBefore = true;
    // Closing a note KEEPS it when it was held long enough. Dropping it instead used to discard
    // the last note before every rest, which is the note a phrase actually ends on.
    const close = breaksPhrase => {
      if (current && current.endAt - current.startAt >= NOTE_HOLD_MS) notes.push(current);
      current = null;
      if (breaksPhrase) brokeBefore = true;
    };
    for (const sample of samples) {
      if (!finite(sample?.semitone) || !finite(sample?.at)) continue;
      const clarity = clamp(sample.clarity);
      if (clarity < 0.04) { close(true); continue; }
      if (current) {
        // Silence re-articulates. A pedal tone struck four times is four notes, and merging them
        // into one long note is what made an ostinato cell look like a single sustained pitch.
        const gap = sample.at - current.endAt;
        if (gap > PHRASE_GAP_MS) close(true);
        else if (gap > NOTE_GAP_MS) close(false);
      }
      if (current && Math.abs(sample.semitone - current.semitone) <= NOTE_TOLERANCE) {
        current.samples += 1;
        current.endAt = sample.at;
        current.clarity = (current.clarity * (current.samples - 1) + clarity) / current.samples;
        // Running mean keeps a slightly drifting sustained note as one note.
        current.semitone = (current.semitone * (current.samples - 1) + sample.semitone) / current.samples;
        continue;
      }
      close(false);
      current = { semitone: sample.semitone, startAt: sample.at, endAt: sample.at,
        clarity, samples: 1, phraseBreak: brokeBefore };
      brokeBefore = false;
    }
    close(true);
    return notes;
  }

  // Direction signature of a short window, used as a transposition-invariant motif fingerprint:
  // a motif that returns a step higher has the same signature, which is what makes it the same
  // motif musically.
  const signature = intervals => intervals
    .map(value => value > STEP_SEMITONES ? "U" : value < -STEP_SEMITONES ? "D" : value > 0.6 ? "u" : value < -0.6 ? "d" : "-")
    .join("");

  // Periodicity of a token sequence, corrected for the chance that two random tokens match.
  // Counting how often the single most common n-gram appears would penalise exactly the case this
  // is meant to detect: a motif that repeats many times leaves many overlapping windows, so its
  // "share of windows" stays low no matter how periodic the line is.
  function repeatedPatternShare(tokens, minPeriod = 2) {
    if (tokens.length < minPeriod * 2 + 1) return 0;
    const frequency = new Map();
    for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
    const chance = [...frequency.values()].reduce((sum, count) => sum + (count / tokens.length) ** 2, 0);
    let best = 0;
    for (let period = minPeriod; period <= Math.floor(tokens.length / 2); period++) {
      let matches = 0;
      for (let index = period; index < tokens.length; index++) if (tokens[index] === tokens[index - period]) matches += 1;
      const share = matches / (tokens.length - period);
      if (share > best) best = share;
    }
    return chance >= 1 ? 0 : clamp((best - chance) / (1 - chance));
  }

  function classifyContour(pitches) {
    const span = Math.max(...pitches) - Math.min(...pitches);
    if (span < 1.2) return "static";
    const intervals = pitches.slice(1).map((value, index) => value - pitches[index]);
    const directions = intervals.filter(value => Math.abs(value) > 0.6).map(Math.sign);
    const turns = directions.slice(1).filter((value, index) => value !== directions[index]).length;
    const half = Math.floor(pitches.length / 2);
    const first = mean(pitches.slice(0, half));
    const second = mean(pitches.slice(pitches.length - half));
    const netShare = (second - first) / span;
    if (netShare > 0.45) return "ascending";
    if (netShare < -0.45) return "descending";
    // Checked before arch/inverted-arch: a zigzag can easily place its single highest note near
    // the middle without being an arch in any musical sense.
    if (directions.length >= 4 && turns / Math.max(1, directions.length - 1) >= 0.4) return "wave";
    const peakIndex = pitches.indexOf(Math.max(...pitches));
    const troughIndex = pitches.indexOf(Math.min(...pitches));
    const middle = (pitches.length - 1) / 2;
    const centred = index => Math.abs(index - middle) <= pitches.length * 0.3;
    if (centred(peakIndex) && span >= 2) return "arched";
    if (centred(troughIndex) && span >= 2) return "inverted_arch";
    return "wave";
  }

  /**
   * @param samples  oldest-to-newest {at, semitone, clarity} predominant-pitch samples.
   */
  function analyze({ samples = [], bpm = 0 } = {}) {
    const trajectory = (Array.isArray(samples) ? samples : []).filter(item => finite(item?.semitone));
    if (trajectory.length < MIN_NOTES) return nulls("insufficient-samples");
    const notes = segment(trajectory);
    if (notes.length < MIN_NOTES) return nulls("insufficient-notes");
    const clarity = mean(notes.map(note => note.clarity));
    if (clarity < MIN_CLARITY) return nulls("unclear-pitch");

    const pitches = notes.map(note => note.semitone);
    const intervals = pitches.slice(1).map((value, index) => value - pitches[index]);
    const magnitudes = intervals.map(Math.abs);
    const moving = magnitudes.filter(value => value > 0.6);
    const span = Math.max(...pitches) - Math.min(...pitches);

    // Net rise or fall over the window, in semitones per note, signed and normalised against a
    // steep 3-semitones-per-note slope. Contour class is a label; this is the continuous version
    // the impression layer can threshold on.
    const contourSlope = Math.max(-1, Math.min(1, (pitches[pitches.length - 1] - pitches[0]) / Math.max(1, pitches.length - 1) / 3));
    const averageMagnitude = mean(magnitudes);
    const variance = mean(magnitudes.map(value => (value - averageMagnitude) ** 2));
    // Ratios are taken over MOVING intervals only: a melody that mostly sustains should not read
    // as "stepwise" just because repeated notes are technically small intervals.
    const stepwiseMotion = moving.length >= 3
      ? clamp(moving.filter(value => value <= STEP_SEMITONES).length / moving.length) : null;
    const leapLikelihood = moving.length >= 3
      ? clamp(moving.filter(value => value >= LEAP_SEMITONES).length / moving.length) : null;

    const tokens = signature(intervals).split("");
    const motifRecurrence = repeatedPatternShare(tokens, 2);
    // Same shape at a different pitch level. A window must actually change direction to qualify:
    // a plain rising scale technically repeats "step up" forever, and calling that a melodic
    // sequence would be a true statement about nothing.
    let sequenceLikelihood = null;
    if (tokens.length >= 8) {
      const groups = new Map();
      for (let index = 0; index + 3 <= tokens.length; index++) {
        const window = tokens.slice(index, index + 3);
        if (new Set(window).size < 2) continue;
        const key = window.join("");
        groups.set(key, [...(groups.get(key) || []), pitches[index]]);
      }
      const transposed = [...groups.values()].filter(starts => starts.length > 1 &&
        Math.max(...starts) - Math.min(...starts) > STEP_SEMITONES).length;
      sequenceLikelihood = groups.size ? clamp(transposed / groups.size * 2) : 0;
    }
    const pitchTokens = pitches.map(value => String(Math.round(value)));
    const melodicRepetition = repeatedPatternShare(pitchTokens, 2);

    // Phrases: runs of notes separated by a real timing gap.
    const phrases = [];
    for (const note of notes) {
      if (!phrases.length || note.phraseBreak) phrases.push([note]);
      else phrases[phrases.length - 1].push(note);
    }
    const sized = phrases.filter(phrase => phrase.length >= 2);
    const phraseLength = sized.length ? Math.round(mean(sized.map(phrase => phrase.length))) : null;
    let phraseRegularity = null;
    if (sized.length >= 3) {
      const durations = sized.map(phrase => phrase[phrase.length - 1].endAt - phrase[0].startAt).filter(value => value > 0);
      const centre = mean(durations);
      const spread = centre > 0
        ? Math.sqrt(mean(durations.map(value => (value - centre) ** 2))) / centre : 1;
      phraseRegularity = clamp(1 - spread);
    }

    // Section 6: response form is A/B alternation between neighbouring phrases -- a contrasting
    // register or direction, repeated. It is never inferred from genre, and the stronger
    // "call and response" wording is left to the knowledge layer's high-confidence gate.
    let callResponseLikelihood = null;
    if (sized.length >= 4) {
      const centres = sized.map(phrase => mean(phrase.map(note => note.semitone)));
      const contrasts = centres.slice(1).map((value, index) => Math.abs(value - centres[index]));
      const alternating = centres.slice(2).filter((value, index) =>
        Math.sign(value - centres[index + 1]) !== Math.sign(centres[index + 1] - centres[index]) &&
        Math.abs(value - centres[index + 1]) > 1).length;
      const alternationShare = clamp(alternating / Math.max(1, centres.length - 2));
      const contrastShare = clamp(mean(contrasts) / 5);
      callResponseLikelihood = clamp(alternationShare * 0.6 + contrastShare * 0.4) *
        (phraseRegularity === null ? 0.7 : clamp(0.55 + phraseRegularity * 0.45));
    }

    const spanMs = notes[notes.length - 1].endAt - notes[0].startAt;
    // Notes per second, normalised against 6 notes/second as a busy upper bound. This is measured
    // from the trajectory itself rather than borrowed from chroma motion.
    const melodicDensity = spanMs > 0 ? clamp(notes.length / (spanMs / 1000) / 6) : null;
    const contour = classifyContour(pitches);
    const netMove = pitches[pitches.length - 1] - pitches[0];
    const melodicDirection = span < 1.2 ? "static"
      : netMove > Math.max(1.5, span * 0.35) ? "ascending"
        : netMove < -Math.max(1.5, span * 0.35) ? "descending" : "mixed";
    const confidence = clamp(clamp(clarity * 2.2) * 0.6 + Math.min(1, notes.length / 24) * 0.4);
    return {
      melodicContour: contour,
      melodicDirection,
      melodicRange: clamp(span / 24),
      melodicContourRange: clamp(span / 24),
      averageInterval: clamp(averageMagnitude / 12),
      intervalVariance: clamp(variance / 36),
      stepwiseMotion, leapLikelihood,
      motifStrength: motifRecurrence, motifRecurrence, melodicRepetition, sequenceLikelihood,
      phraseLength, phraseRegularity,       callResponseLikelihood, melodicDensity, contourSlope,
      noteCount: notes.length, phraseCount: sized.length, confidence, reason: "measured"
    };
  }

  return { analyze, segment, classifyContour, signature, repeatedPatternShare,
    MIN_NOTES, MIN_CLARITY, STEP_SEMITONES, LEAP_SEMITONES, PHRASE_GAP_MS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MelodyContour;
