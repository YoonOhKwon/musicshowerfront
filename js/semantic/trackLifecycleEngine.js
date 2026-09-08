// TrackLifecycleEngine: Manages the explicit audio lifecycle state machine,
// boundary detection, compound request identity, and atomic reset contracts for
// Music Shower.
//
// Lifecycle States:
//   - NO_AUDIO: No audio stream / silent startup
//   - LISTENING_NEW: Preliminary listening on a newly detected track (0-10s)
//   - LISTENING_STABLE: Sustained listening on the current track (>10s)
//   - PAUSE_SUSPECTED: Silence under 1.5s -- not yet a confirmed pause, purely observational.
//   - PAUSED: Confirmed silence (1.5s - 7s). State is frozen; track memory preserved!
//   - RESUMING: Audio returned after PAUSED and passed the same acoustic-discontinuity check a
//     continuous stream would -- same song, same trackEpoch. (A gap followed by a DIFFERENT
//     acoustic signature is TRACK_CHANGED instead, never RESUMING -- see TrackBoundaryDetector.)
//   - TRACK_CHANGED: Acoustic discontinuity (with or without an intervening gap) or extended
//     silence. trackEpoch increments.
//   - AUDIO_REMOVED: Audio stopped or silence > 7s. Complete invalidation.
//
// Works in both Node.js and browser environments.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TrackLifecycleEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  const AudioLifecycleState = Object.freeze({
    NO_AUDIO: "NO_AUDIO",
    LISTENING_NEW: "LISTENING_NEW",
    LISTENING_STABLE: "LISTENING_STABLE",
    PAUSE_SUSPECTED: "PAUSE_SUSPECTED",
    PAUSED: "PAUSED",
    RESUMING: "RESUMING",
    TRACK_CHANGED: "TRACK_CHANGED",
    AUDIO_REMOVED: "AUDIO_REMOVED"
  });

  class TrackBoundaryDetector {
    constructor(options = {}) {
      this.options = {
        pauseSilenceMs: 1500,
        // A viewer watching a reactive visualizer reads 10+ seconds of an unchanged Flamingo
        // interpretation after they stopped the music as "this is stuck," not "this is patiently
        // waiting". 7s still survives a normal pause/resume (a 5s bathroom-break-length pause
        // must stay PAUSED, not be mistaken for a stop) while resolving well before the old 12s
        // made a genuine stop feel broken.
        removeSilenceMs: 7000,
        tempoJumpThreshold: 0.35,
        // Within this ratio the tempo counts as held, which vetoes non-tempo boundaries. A
        // beatmatched DJ transition is the one case this gets wrong, so an overwhelming identity
        // collapse (tempoLockOverrideSimilarity) is still allowed through it.
        tempoLockRatio: 0.04,
        tempoLockOverrideSimilarity: 0.45,
        boundaryThreshold: 0.72,
        suspicionThreshold: 0.42,
        softBoundaryThreshold: 0.50,
        confirmationMs: 900,
        suspicionGraceMs: 550,
        // bpm/chroma/spectralNovelty are all smoothed rolling values (chroma is a moving average
        // over a feature-history window, novelty is an EMA with smoothing=0.3, bpm is a median
        // over recent beat intervals) -- comparing the current tick against the tick from ~16-250ms
        // earlier can NEVER see a real discontinuity, because a smoothed signal takes seconds to
        // actually move regardless of how large the underlying change eventually is. The baseline
        // is only allowed to roll forward this often, so every comparison spans enough real time
        // for a genuine track change to have actually shown up in these signals.
        baselineRefreshMs: 2500,
        // Track signature. The 2.5s baseline answers "did something just change?" -- a drop, a
        // breakdown, a chorus entry and a brand new song all answer that YES equally loudly, which
        // is why boundary detection on its own both cuts mid-song and misses real changes. The
        // signature answers the DIFFERENT question "is this still the same piece of music?": it is
        // a slowly-accumulated timbral/tonal profile of the whole current track, which a section
        // change still matches and a new track does not. Both answers together separate the cases.
        signatureAlpha: 0.02,
        minSignatureSamples: 45,
        // Fallback thresholds, used only until the track's own variation band is learned. Fixed
        // numbers cannot work on their own: how much timbre naturally moves between sections is a
        // property of the SONG. A steady ambient piece sits at 0.99 all the way through, while an
        // arrangement-heavy track can dip to 0.78 at a drop without ever stopping being itself --
        // one fixed threshold either cuts the second song mid-drop or goes blind to real changes.
        signatureHoldSimilarity: 0.90,
        signatureBreakSimilarity: 0.72,
        // Adaptive band: "held" means still inside this track's own normal variation, "lost" means
        // far outside it AND below an absolute ceiling, so a naturally-jittery track cannot have
        // its band widened until real changes fit inside it.
        identityHoldSigma: 2,
        identityLossSigma: 4,
        identityLossAbsoluteCeiling: 0.86,
        minIdentityBandSamples: 60,
        // A drop dips for a moment and recovers; a different song stays different. Nothing is
        // called an identity loss until it has held for this long.
        identityLossConfirmMs: 1200,
        // Gap partition. A streaming service separates tracks with a short silence; a track does
        // not contain one. Above this length a gap is treated as a partition that must be argued
        // ACROSS rather than a hiccup to be ignored. Deliberately short -- inter-track gaps are
        // often well under a second -- because the cost of noticing one is only that the signature
        // has to vouch for continuity, which a genuine pause/resume does trivially.
        gapPartitionMs: 350,
        // How little may move across a gap, before a signature exists, for it to still count as
        // the same song resuming. Well under suspicionThreshold: this is "nothing happened", not
        // "not enough happened".
        gapContinuityScore: 0.12,
        ...options
      };
      this.reset();
    }

    reset() {
      this.lastAcousticFeatures = null;
      this.lastBaselineAt = 0;
      this.changeSuspectedAt = 0;
      this.lastSuspicionEvidenceAt = 0;
      this.peakSuspicionScore = 0;
      this.peakIdentityCues = 0;
      this.silenceDurationMs = 0;
      this.lastAudibleAt = 0;
      this.silenceStartedAt = 0;
      this.signature = { mfcc: null, samples: 0 };
      this.lastSignatureSimilarity = null;
      // Running mean/mean-absolute-deviation of observed similarity, i.e. how much this particular
      // track's timbre normally wanders. Learned only from stable playback.
      this.identityBand = { mean: 0, dev: 0, samples: 0 };
      this.identityLowSinceMs = 0;
    }

    // Learns the track's own similarity distribution so "unusual for THIS song" replaces "below a
    // number picked in advance". Frozen while a change is suspected, for the same reason the
    // signature itself is: a transition must not be allowed to widen the band that judges it.
    updateIdentityBand(similarity) {
      if (similarity === null) return;
      const band = this.identityBand;
      const alpha = Math.max(0.01, 1 / (band.samples + 1));
      const deviation = Math.abs(similarity - band.mean);
      band.mean = band.samples === 0 ? similarity : band.mean + (similarity - band.mean) * alpha;
      band.dev = band.samples === 0 ? 0 : band.dev + (deviation - band.dev) * alpha;
      band.samples += 1;
    }

    identityThresholds() {
      const band = this.identityBand;
      if (band.samples < this.options.minIdentityBandSamples) {
        return { hold: this.options.signatureHoldSimilarity, loss: this.options.signatureBreakSimilarity, adaptive: false };
      }
      // A floor of 0.02 on the deviation keeps a perfectly steady track from producing a
      // zero-width band that any jitter at all would fall outside of.
      const dev = Math.max(0.02, band.dev);
      return {
        hold: Math.max(0.5, band.mean - this.options.identityHoldSigma * dev),
        loss: Math.min(this.options.identityLossAbsoluteCeiling, band.mean - this.options.identityLossSigma * dev),
        adaptive: true
      };
    }

    // Running mean of the track's TIMBRAL identity. Deliberately not updated while a change is
    // suspected, and -- more importantly -- not updated once the current audio has stopped clearly
    // matching it. Without that second guard the signature slowly walks into whatever is playing,
    // which is exactly how a crossfade erases the evidence that anything changed at all.
    updateSignature(features, similarity) {
      if (similarity !== null && similarity < this.options.signatureHoldSimilarity) return;
      const blend = (previous, incoming, alpha) => {
        if (!Array.isArray(incoming) || !incoming.length) return previous;
        if (!Array.isArray(previous) || previous.length !== incoming.length) return incoming.slice();
        return previous.map((value, index) => value + ((Number(incoming[index]) || 0) - value) * alpha);
      };
      // Converge quickly while the profile is still forming, then settle into a slow drift so an
      // established track keeps its identity instead of chasing whatever just played.
      const alpha = Math.max(this.options.signatureAlpha, 1 / (this.signature.samples + 1));
      const blended = blend(this.signature.mfcc, features.mfcc, alpha);
      if (!blended) return;
      this.signature.mfcc = blended;
      this.signature.samples += 1;
    }

    // How much the current audio still looks like the track this signature was built from.
    // null while the profile is too young to judge -- never treated as either match or mismatch.
    signatureSimilarity(features) {
      if (this.signature.samples < this.options.minSignatureSamples) return null;
      const cosine = (left, right) => {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null;
        let dot = 0, normA = 0, normB = 0;
        for (let index = 0; index < left.length; index++) {
          const a = Number(left[index]) || 0;
          const b = Number(right[index]) || 0;
          dot += a * b; normA += a * a; normB += b * b;
        }
        return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : null;
      };
      // Timbre only, and MFCC coefficient 0 excluded because it tracks loudness. Key is
      // deliberately NOT part of track identity: one song changing chords is ordinary, two songs
      // sharing a key is ordinary, so folding chroma in here made a mid-song chord change read as
      // a different track while leaving a same-key track change invisible -- both backwards.
      return cosine(
        Array.isArray(this.signature.mfcc) ? this.signature.mfcc.slice(1, 9) : [],
        Array.isArray(features.mfcc) ? features.mfcc.slice(1, 9) : []);
    }

    // How different `features` looks from the acoustic signature captured before the most recent
    // gap. Returns null when there is nothing to compare against (first tick ever, or right after
    // a reset) -- null means "unknown", never "continuous".
    discontinuityEvidence(features) {
      if (!this.lastAcousticFeatures || !features) return null;
      let score = 0;
      let identityCues = 0;
      const components = {};

      const cosine = (left, right) => {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null;
        let dot = 0, normA = 0, normB = 0;
        for (let index = 0; index < left.length; index++) {
          const a = Number(left[index]) || 0;
          const b = Number(right[index]) || 0;
          dot += a * b; normA += a * a; normB += b * b;
        }
        return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : null;
      };

      // 1. Tempo. A jump is evidence of a boundary -- but a tempo that stays LOCKED is evidence
      // against one, and that half was missing. Songs do not usually hold another song's exact
      // tempo, while every section of one song holds its own, so a locked tempo is the single
      // strongest "this is still the same piece" signal available.
      let tempoLocked = false;
      const prevBpm = this.lastAcousticFeatures.bpm;
      const curBpm = features.bpm;
      const conf = Math.min(this.lastAcousticFeatures.bpmConfidence || 0, features.bpmConfidence || 0);
      if (prevBpm > 0 && curBpm > 0 && conf >= 0.65) {
        const ratio = Math.abs(curBpm - prevBpm) / prevBpm;
        if (ratio >= this.options.tempoJumpThreshold) {
          score += 0.45; identityCues += 1; components.tempo = 0.45;
        } else if (ratio <= this.options.tempoLockRatio) {
          tempoLocked = true;
        }
      }

      // 2. Chroma / tonal shift
      if (Array.isArray(this.lastAcousticFeatures.chroma) && Array.isArray(features.chroma) &&
          this.lastAcousticFeatures.chroma.length === 12 && features.chroma.length === 12) {
        const similarity = cosine(this.lastAcousticFeatures.chroma, features.chroma);
        if (similarity !== null && similarity < 0.35) {
          score += 0.35; identityCues += 1; components.chroma = 0.35;
        } else if (similarity !== null && similarity < 0.62) {
          score += 0.18; identityCues += 1; components.chroma = 0.18;
        }
      }

      // 3. Spectral / timbral jump
      if (features.spectralNovelty && features.spectralNovelty > 0.8) {
        score += 0.30; components.novelty = 0.30;
      } else if (features.spectralNovelty > 0.45) {
        score += 0.16; components.novelty = 0.16;
      }

      // 4. Persistent timbre signature. BPM can be identical across two songs, and chroma plus a
      // novelty spike deliberately stays just below the boundary threshold because either can also
      // describe an ordinary section change. A corroborating centroid/flatness/loudness shift
      // closes that gap without allowing any one timbre reading to reset the track by itself.
      const previous = this.lastAcousticFeatures;
      let timbreCueCount = 0;
      if (previous.centroid > 80 && features.centroid > 80) {
        const octaveDistance = Math.abs(Math.log2(features.centroid / previous.centroid));
        if (octaveDistance >= 0.55) timbreCueCount += 1;
      }
      if (Number.isFinite(previous.flatness) && Number.isFinite(features.flatness) &&
          Math.abs(features.flatness - previous.flatness) >= 0.18) timbreCueCount += 1;
      if (previous.rms > 0.002 && features.rms > 0.002) {
        const dbDistance = Math.abs(20 * Math.log10(features.rms / previous.rms));
        if (dbDistance >= 8) timbreCueCount += 1;
      }
      // Loudness, brightness, MFCC shape and band balance are FOUR readings of one phenomenon --
      // "the timbre changed" -- not four independent witnesses. Counting them separately let a
      // single loud, bright drop manufacture a three-cue quorum on its own, which is precisely how
      // a song got cut in half. They now contribute score independently but a single shared cue.
      let timbreFamilyCue = 0;
      if (timbreCueCount >= 2) {
        score += 0.20; timbreFamilyCue = 1; components.timbre = 0.20;
      } else if (timbreCueCount === 1 && features.spectralNovelty > 0.8) {
        score += 0.10; timbreFamilyCue = 1; components.timbre = 0.10;
      }

      // MFCCs and coarse spectral-band balance carry timbral identity even when two tracks share
      // tempo and key. Ignore MFCC coefficient 0 because it is dominated by overall loudness.
      const previousMfcc = Array.isArray(previous.mfcc) ? previous.mfcc.slice(1, 9) : [];
      const currentMfcc = Array.isArray(features.mfcc) ? features.mfcc.slice(1, 9) : [];
      const mfccSimilarity = cosine(previousMfcc, currentMfcc);
      if (mfccSimilarity !== null && mfccSimilarity < 0.72) {
        score += 0.22; timbreFamilyCue = 1; components.mfcc = 0.22;
      } else if (mfccSimilarity !== null && mfccSimilarity < 0.88) {
        score += 0.12; timbreFamilyCue = 1; components.mfcc = 0.12;
      }

      const normalizeBands = values => {
        if (!Array.isArray(values) || values.length < 3) return null;
        const clean = values.slice(0, 3).map(value => Math.max(0, Number(value) || 0));
        const total = clean.reduce((sum, value) => sum + value, 0);
        return total > 0 ? clean.map(value => value / total) : null;
      };
      const previousBands = normalizeBands(previous.bands);
      const currentBands = normalizeBands(features.bands);
      if (previousBands && currentBands) {
        const bandDistance = previousBands.reduce((sum, value, index) =>
          sum + Math.abs(value - currentBands[index]), 0) / 2;
        if (bandDistance >= 0.30) {
          score += 0.18; timbreFamilyCue = 1; components.bands = 0.18;
        } else if (bandDistance >= 0.18) {
          score += 0.10; timbreFamilyCue = 1; components.bands = 0.10;
        }
      }

      const embeddingNovelty = Math.max(0, Math.min(1, Number(features.embeddingNovelty) || 0));
      if (embeddingNovelty >= 0.38) {
        score += 0.25; identityCues += 1; components.embedding = 0.25;
      } else if (embeddingNovelty >= 0.22) {
        score += 0.14; identityCues += 1; components.embedding = 0.14;
      }

      identityCues += timbreFamilyCue;
      return { score, identityCues, components, tempoLocked };
    }

    discontinuityScore(features) {
      return this.discontinuityEvidence(features)?.score ?? null;
    }

    clearSuspicion() {
      this.changeSuspectedAt = 0;
      this.lastSuspicionEvidenceAt = 0;
      this.peakSuspicionScore = 0;
      this.peakIdentityCues = 0;
    }

    // Evaluates acoustic features and silence duration to detect track boundary
    evaluate({ isAudible, now, features = {} }) {
      const at = Number.isFinite(now) ? now : Date.now();

      if (!isAudible) {
        if (!this.silenceStartedAt) {
          this.silenceStartedAt = at;
        }
        this.silenceDurationMs = at - this.silenceStartedAt;
        if (this.silenceDurationMs >= this.options.removeSilenceMs) {
          return { type: "AUDIO_REMOVED", silenceMs: this.silenceDurationMs };
        }
        if (this.silenceDurationMs >= this.options.pauseSilenceMs) {
          return { type: "PAUSED", silenceMs: this.silenceDurationMs };
        }
        // Named and observable (not folded silently into whatever state came before it), but not
        // yet a confirmed pause -- resolves back to CONTINUOUS/RESUMED_FROM_PAUSE/TRACK_CHANGED on
        // the very next audible tick.
        return { type: "PAUSE_SUSPECTED", silenceMs: this.silenceDurationMs };
      }

      // Audible audio is present
      const wasSilent = this.silenceStartedAt > 0;
      const gapMs = wasSilent ? this.silenceDurationMs : 0;
      const hadLongSilence = wasSilent && this.silenceDurationMs >= this.options.removeSilenceMs;
      const hadPauseSilence = wasSilent && this.silenceDurationMs >= this.options.pauseSilenceMs && !hadLongSilence;

      this.silenceStartedAt = 0;
      this.silenceDurationMs = 0;
      this.lastAudibleAt = at;

      if (hadLongSilence) {
        // Extended silence forfeits the acoustic signature entirely -- there is nothing left to
        // compare the resumed audio against, so this is unconditionally a fresh track.
        this.lastAcousticFeatures = { ...features };
        this.lastBaselineAt = at;
        return { type: "TRACK_CHANGED", reason: "resumed_after_extended_silence" };
      }

      // A gap's duration alone cannot tell "same song, quiet moment" from "the song changed while
      // nobody was watching" -- resuming from a pause (or even a brief blip) still has to pass the
      // SAME acoustic-discontinuity check a fully continuous stream would.
      const evidence = this.discontinuityEvidence(features);
      const gapBonus = wasSilent && evidence?.identityCues > 0
        ? (gapMs >= 900 ? 0.25 : gapMs >= 250 ? 0.12 : 0)
        : 0;
      // "Is this still the same piece of music?", asked independently of "did something just
      // change?". A drop or breakdown scores high on the second question but still matches the
      // track signature; a genuinely new song stops matching it and stays unmatched.
      const signatureSimilarity = this.signatureSimilarity(features);
      this.lastSignatureSimilarity = signatureSimilarity;
      const thresholds = this.identityThresholds();
      const identityHeld = signatureSimilarity !== null && signatureSimilarity >= thresholds.hold;
      // Momentarily unusual is not the same as no longer this song. A drop leaves the band for a
      // second and comes back; a different track leaves it and stays gone.
      const identityLow = signatureSimilarity !== null && signatureSimilarity <= thresholds.loss;
      if (identityLow) {
        if (!this.identityLowSinceMs) this.identityLowSinceMs = at;
      } else {
        this.identityLowSinceMs = 0;
      }
      const identityLost = identityLow &&
        at - this.identityLowSinceMs >= this.options.identityLossConfirmMs;
      // A lost signature must carry real score, not only a cue count. Two songs sharing tempo and
      // key change almost nothing the 2.5s baseline can see -- the timbral profile is the only
      // thing that moved, so if it does not also move the score, the suspicion threshold is never
      // reached and the change stays invisible no matter how certain the signature is.
      const signatureBreakScore = !identityLost ? 0
        : signatureSimilarity <= 0.40 ? 0.30
          : signatureSimilarity <= 0.60 ? 0.24 : 0.18;
      const score = evidence === null ? null : evidence.score + gapBonus + signatureBreakScore;

      // ---- Gap partition ----------------------------------------------------------------
      // On a streaming service the reliable boundary marker is not an acoustic jump, it is the
      // SILENCE between tracks. Two songs can share tempo, key and production closely enough that
      // no feature comparison separates them, but almost nothing puts a second of digital silence
      // in the MIDDLE of a track. So once a real gap has been observed the question inverts: stop
      // asking "is there enough evidence that this changed?" and start asking "is there positive
      // evidence that this is still the same piece?".
      //
      // This is what keeps a pause honest rather than breaking it. A paused song resumes as
      // itself: its signature still matches, continuity is proven, and nothing resets. A new song
      // after the same gap cannot prove that, and resets.
      const gapPartition = wasSilent && gapMs >= this.options.gapPartitionMs;
      let continuityProvenAcrossGap = false;
      if (gapPartition) {
        if (signatureSimilarity !== null) {
          // A mature profile answers directly. Use the hold threshold, not the loss threshold:
          // across a gap we want affirmative sameness, not merely the absence of proof otherwise.
          continuityProvenAcrossGap = signatureSimilarity >= thresholds.hold;
        } else if (evidence === null) {
          // Nothing was ever heard before the gap, so there is no track to have changed away from.
          continuityProvenAcrossGap = true;
        } else {
          // No profile yet (a gap early in a track, or right after a previous reset). Fall back to
          // the direct before/after comparison: if essentially nothing moved across the silence,
          // that is the same song resuming.
          continuityProvenAcrossGap = evidence.identityCues === 0 &&
            evidence.score <= this.options.gapContinuityScore;
        }
      }
      const gapBoundary = gapPartition && !continuityProvenAcrossGap;

      // A large, high-confidence tempo break plus a strong novelty event is the original proven
      // zero-gap transition shape. Count that pair as sufficient corroboration even though tempo
      // is the only long-term identity component; otherwise require two identity components.
      const provenTempoBreak = evidence?.components.tempo && evidence.components.novelty === 0.30 &&
        score >= this.options.boundaryThreshold;
      // A losing signature is an identity cue in its own right, and it is precisely the cue that
      // was missing when two songs shared tempo and key: those transitions produced only two cues
      // and never reached the confirmation bar below.
      const identityCues = (evidence?.identityCues || 0) + (identityLost ? 1 : 0);
      const strongMultiIdentityBreak = identityCues >= 2 && score >= 0.78 && !identityHeld;
      // "Everything moved at once" is what a drop, a chorus entry and a breakdown all look like on
      // a single tick, so it may only end a track instantly when there is nothing better to ask.
      // With a mature track signature there IS something better: wait the ~1s confirmation window
      // below and see whether the change is still there. Without one (early in a track, or a very
      // short observation) instant detection is all we have, and staying blind to it was how
      // same-tempo, same-key transitions used to slip past.
      const canJudgeByIdentity = signatureSimilarity !== null && !identityLost;
      const hardBoundary = score !== null &&
        (provenTempoBreak || gapBoundary || (strongMultiIdentityBreak && !canJudgeByIdentity));
      const suspicious = score !== null && identityCues >= 2 && score >= this.options.suspicionThreshold;

      if (suspicious) {
        if (!this.changeSuspectedAt) this.changeSuspectedAt = at;
        this.lastSuspicionEvidenceAt = at;
        this.peakSuspicionScore = Math.max(this.peakSuspicionScore, score);
        this.peakIdentityCues = Math.max(this.peakIdentityCues, identityCues);
      } else if (this.changeSuspectedAt && at - this.lastSuspicionEvidenceAt > this.options.suspicionGraceMs) {
        this.clearSuspicion();
      }

      // A held signature vetoes the soft path outright: sustained multi-cue change that still
      // sounds like the same instruments and the same piece is a section, not a track. This is the
      // shape that was cutting mid-song. An identity that has genuinely gone (identityLost) drops
      // the confirmation bar back to two cues, because the missing third cue WAS the signature.
      // A locked tempo vetoes the soft path. Every section of one song keeps its own tempo, while
      // two different songs rarely share one to within a few percent -- so "the timbre changed a
      // lot but the tempo never moved" describes a drop or a breakdown, not a new track. The
      // exception is a beatmatched DJ transition, which still gets through when the timbral
      // identity has collapsed outright rather than merely shifted.
      // The veto needs the signature to actually speak: it means "the profile says this is still
      // the same piece AND the tempo agrees". With no mature profile there is nothing to corroborate
      // a locked tempo, so blocking on tempo alone would just go blind to same-tempo changes again.
      const tempoVeto = Boolean(evidence?.tempoLocked) && signatureSimilarity !== null &&
        signatureSimilarity > this.options.tempoLockOverrideSimilarity;
      // Three independent cues is the bar when a mature signature exists to raise it with: chroma
      // and timbre both moving is a drop as often as it is a new track, and the signature is what
      // tells the two apart. Before the profile matures there is no such arbiter, so demanding a
      // third cue would only mean missing same-tempo, same-key transitions -- back to two.
      const requiredCues = identityLost || this.peakSuspicionScore >= 0.78 ||
        signatureSimilarity === null ? 2 : 3;
      const persistentBoundary = this.changeSuspectedAt && !identityHeld && !tempoVeto &&
        at - this.changeSuspectedAt >= this.options.confirmationMs &&
        this.peakSuspicionScore >= this.options.softBoundaryThreshold &&
        this.peakIdentityCues >= requiredCues;
      if (hardBoundary || persistentBoundary) {
        this.lastAcousticFeatures = { ...features };
        this.lastBaselineAt = at;
        const components = { ...(evidence?.components || {}) };
        if (gapBonus) components.gap = gapBonus;
        if (signatureSimilarity !== null) components.signature = Number(signatureSimilarity.toFixed(3));
        this.clearSuspicion();
        // The old track's profile -- and the variation band learned from it -- must not survive
        // into the new one; the next song wanders by its own amount, not the last one's.
        this.signature = { mfcc: null, samples: 0 };
        this.lastSignatureSimilarity = null;
        this.identityBand = { mean: 0, dev: 0, samples: 0 };
        this.identityLowSinceMs = 0;
        return {
          type: "TRACK_CHANGED",
          reason: gapBoundary ? "gap_without_proven_continuity"
            : wasSilent ? "acoustic_discontinuity_after_gap"
            : hardBoundary ? "acoustic_discontinuity" : "persistent_acoustic_identity_change",
          score,
          identityCues,
          signatureSimilarity,
          components
        };
      }

      // Only extend the signature (and the band that judges it) while nothing looks like a
      // transition -- see updateSignature/updateIdentityBand. Note the band DOES learn from the
      // ordinary dips a song makes on its own, which is the entire point: that is what teaches it
      // how far this particular track wanders before anything is actually wrong.
      if (!this.changeSuspectedAt) {
        this.updateIdentityBand(signatureSimilarity);
        this.updateSignature(features, signatureSimilarity);
      }

      // No discontinuity yet -- but only roll the baseline forward once it is old enough. Refreshing
      // it every tick (the previous behavior) means every comparison is against ~16-250ms-old
      // smoothed features, which is why real track changes went undetected: the signals simply had
      // not had time to move yet. Holding the baseline for a few seconds lets a genuine change
      // actually accumulate into a visible difference before the reference point slides forward.
      if (!this.changeSuspectedAt && (!this.lastAcousticFeatures ||
          (at - this.lastBaselineAt >= this.options.baselineRefreshMs && (score === null || score < 0.28)))) {
        this.lastAcousticFeatures = { ...features };
        this.lastBaselineAt = at;
      }
      if (hadPauseSilence) {
        return { type: "RESUMED_FROM_PAUSE", reason: "resumed_after_pause" };
      }
      return { type: "CONTINUOUS" };
    }
  }

  class LifecycleEngine {
    constructor(options = {}) {
      this.options = options;
      this.detector = new TrackBoundaryDetector(options.detectorOptions);
      this.onResetTrack = options.onResetTrack || (() => {});
      this.onFreezePause = options.onFreezePause || (() => {});
      this.onResumeTrack = options.onResumeTrack || (() => {});
      this.onAudioRemoved = options.onAudioRemoved || (() => {});
      this.resetAll();
    }

    resetAll(sessionId = 1) {
      this.sessionId = sessionId;
      this.trackEpoch = 1;
      this.sectionEpoch = 1;
      this.state = AudioLifecycleState.NO_AUDIO;
      this.activeAudioMs = 0;
      this.lastTickAt = 0;
      this.lastBoundaryReason = null;
      this.staleResponseDropCount = 0;
      this.activeRequests = new Set();
      this.detector.reset();
    }

    getState() {
      return this.state;
    }

    getTrackEpoch() {
      return this.trackEpoch;
    }

    getSectionEpoch() {
      return this.sectionEpoch;
    }

    getActiveAudioMs() {
      return this.activeAudioMs;
    }

    isListening() {
      return this.state === AudioLifecycleState.LISTENING_NEW ||
             this.state === AudioLifecycleState.LISTENING_STABLE ||
             this.state === AudioLifecycleState.RESUMING;
    }

    // Creates compound request identity for in-flight requests
    createCompoundIdentity(requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`) {
      return {
        sessionId: this.sessionId,
        trackEpoch: this.trackEpoch,
        sectionEpoch: this.sectionEpoch,
        requestId
      };
    }

    // Validates whether an incoming asynchronous response still belongs to the current track
    validateResponse(responseTrackEpoch) {
      if (responseTrackEpoch === undefined || responseTrackEpoch === null) return true;
      const match = Number(responseTrackEpoch) === this.trackEpoch;
      if (!match) {
        this.staleResponseDropCount += 1;
      }
      return match;
    }

    // Tick called on every audio frame
    tick({ isAudible = false, now = Date.now(), features = {} } = {}) {
      const at = now;
      const delta = this.lastTickAt ? Math.min(250, Math.max(0, at - this.lastTickAt)) : 0;
      this.lastTickAt = at;

      // Only accumulate active audio duration when sound is audibly playing!
      if (isAudible && this.isListening()) {
        this.activeAudioMs += delta;
      }

      // Check boundary transitions
      const boundary = this.detector.evaluate({ isAudible, now: at, features });

      if (boundary.type === "AUDIO_REMOVED") {
        if (this.state !== AudioLifecycleState.AUDIO_REMOVED && this.state !== AudioLifecycleState.NO_AUDIO) {
          this.resetForAudioRemoved("silence_exceeded_remove_threshold");
        }
      } else if (boundary.type === "PAUSED") {
        if (this.state !== AudioLifecycleState.PAUSED && this.state !== AudioLifecycleState.AUDIO_REMOVED) {
          this.freezeForPause();
        }
      } else if (boundary.type === "PAUSE_SUSPECTED") {
        if (this.state !== AudioLifecycleState.PAUSED && this.state !== AudioLifecycleState.AUDIO_REMOVED &&
            this.state !== AudioLifecycleState.NO_AUDIO) {
          this.state = AudioLifecycleState.PAUSE_SUSPECTED;
        }
      } else if (boundary.type === "RESUMED_FROM_PAUSE") {
        if (this.state === AudioLifecycleState.PAUSED) {
          this.resumeSameTrack();
        }
      } else if (boundary.type === "TRACK_CHANGED") {
        this.resetForNewTrack(boundary.reason || "acoustic_boundary_detected");
      } else if (isAudible) {
        if (this.state === AudioLifecycleState.NO_AUDIO || this.state === AudioLifecycleState.AUDIO_REMOVED) {
          this.state = AudioLifecycleState.LISTENING_NEW;
        } else if (this.state === AudioLifecycleState.LISTENING_NEW && this.activeAudioMs >= 10000) {
          this.state = AudioLifecycleState.LISTENING_STABLE;
        } else if (this.state === AudioLifecycleState.RESUMING || this.state === AudioLifecycleState.PAUSE_SUSPECTED) {
          // A suspected pause that never confirmed (or a real pause that turned out to be the
          // same song) resolves the same way a formal RESUMING does -- there is no meaningful
          // difference once the acoustic check has already cleared it.
          this.state = this.activeAudioMs >= 10000 ? AudioLifecycleState.LISTENING_STABLE : AudioLifecycleState.LISTENING_NEW;
        }
      }

      return {
        state: this.state,
        trackEpoch: this.trackEpoch,
        sectionEpoch: this.sectionEpoch,
        activeAudioMs: this.activeAudioMs,
        boundary
      };
    }

    // SoundCloud playback is owned by this page, so its media events are more reliable than
    // inferring transport from silence. This path intentionally has no AUDIO_REMOVED timeout:
    // PAUSED and ENDED retain the same trackEpoch and Flamingo reservoir indefinitely.
    tickAuthoritative({ isPlaying = false, now = Date.now() } = {}) {
      const at = now;
      const delta = this.lastTickAt ? Math.min(250, Math.max(0, at - this.lastTickAt)) : 0;
      this.lastTickAt = at;

      if (isPlaying) {
        if (this.state === AudioLifecycleState.NO_AUDIO || this.state === AudioLifecycleState.AUDIO_REMOVED) {
          this.state = AudioLifecycleState.LISTENING_NEW;
        } else if (this.state === AudioLifecycleState.PAUSED) {
          this.state = AudioLifecycleState.RESUMING;
        }
        if (this.isListening()) this.activeAudioMs += delta;
        if ((this.state === AudioLifecycleState.LISTENING_NEW || this.state === AudioLifecycleState.RESUMING) &&
            this.activeAudioMs >= 10000) {
          this.state = AudioLifecycleState.LISTENING_STABLE;
        }
      }

      return {
        state: this.state,
        trackEpoch: this.trackEpoch,
        sectionEpoch: this.sectionEpoch,
        activeAudioMs: this.activeAudioMs,
        boundary: {
          type: isPlaying ? "AUTHORITATIVE_PLAYING" : "AUTHORITATIVE_IDLE",
          reason: "soundcloud_transport_event",
          authoritative: true
        }
      };
    }

    // Section change within the same track
    advanceSection(reason = "section_change") {
      this.sectionEpoch += 1;
    }

    // ATOMIC RESET CONTRACT: New Track Detected
    resetForNewTrack(reason = "user_or_boundary") {
      this.trackEpoch += 1;
      this.sectionEpoch = 1;
      this.activeAudioMs = 0;
      this.lastBoundaryReason = reason;
      this.state = AudioLifecycleState.LISTENING_NEW;
      this.activeRequests.clear();
      this.detector.reset();
      this.onResetTrack(this.trackEpoch, reason);
    }

    // ATOMIC RESET CONTRACT: Audio Stopped / Extended Silence
    resetForAudioRemoved(reason = "audio_removed") {
      this.state = AudioLifecycleState.AUDIO_REMOVED;
      this.lastBoundaryReason = reason;
      this.activeRequests.clear();
      this.onAudioRemoved(reason);
    }

    // ATOMIC RESET CONTRACT: Pause (Freezes state without clearing reservoir)
    freezeForPause() {
      this.state = AudioLifecycleState.PAUSED;
      this.onFreezePause();
    }

    // ATOMIC RESET CONTRACT: Resume same track
    resumeSameTrack() {
      this.state = AudioLifecycleState.RESUMING;
      this.onResumeTrack();
    }

    inspect() {
      return {
        state: this.state,
        trackEpoch: this.trackEpoch,
        sectionEpoch: this.sectionEpoch,
        activeAudioMs: Math.round(this.activeAudioMs),
        silenceDurationMs: this.detector.silenceDurationMs,
        staleResponseDropCount: this.staleResponseDropCount,
        lastBoundaryReason: this.lastBoundaryReason,
        // "Still the same piece of music?" -- null until the profile has enough samples to judge.
        signatureSimilarity: this.detector.lastSignatureSimilarity,
        signatureSamples: this.detector.signature?.samples || 0,
        changeSuspected: Boolean(this.detector.changeSuspectedAt)
      };
    }
  }

  const defaultEngine = new LifecycleEngine();

  return {
    AudioLifecycleState,
    TrackBoundaryDetector,
    LifecycleEngine,
    defaultEngine
  };
});
