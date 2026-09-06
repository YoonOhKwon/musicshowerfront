// TrackLifecycleEngine: Manages the explicit audio lifecycle state machine,
// boundary detection, compound request identity, and atomic reset contracts for
// Music Shower.
//
// Lifecycle States:
//   - NO_AUDIO: No audio stream / silent startup
//   - LISTENING_NEW: Preliminary listening on a newly detected track (0-10s)
//   - LISTENING_STABLE: Sustained listening on the current track (>10s)
//   - PAUSED: Brief silence / pause (1.5s - 10s). State is frozen; track memory preserved!
//   - RESUMING: Returning from pause. Seamless continuation with existing trackEpoch.
//   - TRACK_CHANGED: Acoustic discontinuity or long silence confirmed. trackEpoch increments.
//   - AUDIO_REMOVED: Audio stopped or silence > 12s. Complete invalidation.
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
    PAUSED: "PAUSED",
    RESUMING: "RESUMING",
    TRACK_CHANGED: "TRACK_CHANGED",
    AUDIO_REMOVED: "AUDIO_REMOVED"
  });

  class TrackBoundaryDetector {
    constructor(options = {}) {
      this.options = {
        pauseSilenceMs: 1500,
        removeSilenceMs: 12000,
        tempoJumpThreshold: 0.35,
        boundaryThreshold: 0.72,
        ...options
      };
      this.reset();
    }

    reset() {
      this.lastAcousticFeatures = null;
      this.boundaryStreak = 0;
      this.silenceDurationMs = 0;
      this.lastAudibleAt = 0;
      this.silenceStartedAt = 0;
    }

    // Evaluates acoustic features and silence duration to detect track boundary
    evaluate({ isAudible, now, features = {} }) {
      const at = now || Date.now();

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
        return { type: "SILENCE_BRIEF", silenceMs: this.silenceDurationMs };
      }

      // Audible audio is present
      const wasSilent = this.silenceStartedAt > 0;
      const hadLongSilence = wasSilent && this.silenceDurationMs >= this.options.removeSilenceMs;
      const hadPauseSilence = wasSilent && this.silenceDurationMs >= this.options.pauseSilenceMs && !hadLongSilence;

      this.silenceStartedAt = 0;
      this.silenceDurationMs = 0;
      this.lastAudibleAt = at;

      if (hadLongSilence) {
        return { type: "TRACK_CHANGED", reason: "resumed_after_extended_silence" };
      }
      if (hadPauseSilence) {
        return { type: "RESUMED_FROM_PAUSE", reason: "resumed_after_pause" };
      }

      // Check acoustic discontinuity across consecutive frames
      if (this.lastAcousticFeatures && features) {
        let discontinuityScore = 0;

        // 1. Tempo jump
        const prevBpm = this.lastAcousticFeatures.bpm;
        const curBpm = features.bpm;
        const conf = Math.min(this.lastAcousticFeatures.bpmConfidence || 0, features.bpmConfidence || 0);
        if (prevBpm > 0 && curBpm > 0 && conf >= 0.65) {
          const ratio = Math.abs(curBpm - prevBpm) / prevBpm;
          if (ratio >= this.options.tempoJumpThreshold) {
            discontinuityScore += 0.45;
          }
        }

        // 2. Chroma / tonal shift
        if (Array.isArray(this.lastAcousticFeatures.chroma) && Array.isArray(features.chroma) &&
            this.lastAcousticFeatures.chroma.length === 12 && features.chroma.length === 12) {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < 12; i++) {
            dot += this.lastAcousticFeatures.chroma[i] * features.chroma[i];
            normA += this.lastAcousticFeatures.chroma[i] ** 2;
            normB += features.chroma[i] ** 2;
          }
          const cosine = (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 1;
          if (cosine < 0.35) discontinuityScore += 0.35;
        }

        // 3. Spectral / timbral jump
        if (features.spectralNovelty && features.spectralNovelty > 0.8) {
          discontinuityScore += 0.30;
        }

        if (discontinuityScore >= this.options.boundaryThreshold) {
          this.boundaryStreak = 0;
          this.lastAcousticFeatures = { ...features };
          return { type: "TRACK_CHANGED", reason: "acoustic_discontinuity", score: discontinuityScore };
        } else {
          this.boundaryStreak = 0;
        }
      }

      this.lastAcousticFeatures = { ...features };
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
        } else if (this.state === AudioLifecycleState.RESUMING) {
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
        lastBoundaryReason: this.lastBoundaryReason
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
