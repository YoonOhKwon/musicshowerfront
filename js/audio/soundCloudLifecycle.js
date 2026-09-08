// SoundCloudLifecycle: authoritative transport state for Music Shower's owned
// SoundCloud player. Unlike acoustic silence detection, pause/end never imply
// that the current track changed and therefore never invalidate its word pool.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SoundCloudLifecycle = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TransportState = Object.freeze({
    DISCONNECTED: "disconnected",
    READY: "ready",
    PLAYING: "playing",
    PAUSED: "paused",
    ENDED: "ended"
  });

  function trackIdentity(track) {
    return String(track?.urn || track?.permalinkUrl || track?.permalink_url || "").trim();
  }

  class Controller {
    constructor({ onEvent = () => {} } = {}) {
      this.onEvent = onEvent;
      this.state = TransportState.DISCONNECTED;
      this.track = null;
      this.identity = "";
      this.lastEvent = null;
      this.positionSeconds = 0;
      this.eventSequence = 0;
    }

    emit(type, extra = {}) {
      const event = {
        type,
        authoritative: true,
        sequence: ++this.eventSequence,
        at: Date.now(),
        track: this.track,
        identity: this.identity,
        transport: this.state,
        positionSeconds: this.positionSeconds,
        ...extra
      };
      this.lastEvent = event;
      this.onEvent(event);
      return event;
    }

    loadTrack(track) {
      const nextIdentity = trackIdentity(track);
      if (!nextIdentity) throw new Error("SoundCloud track identity is required.");
      const previousIdentity = this.identity;
      const changed = Boolean(previousIdentity && previousIdentity !== nextIdentity);
      this.track = track;
      this.identity = nextIdentity;
      this.positionSeconds = 0;
      this.state = TransportState.READY;
      return this.emit(changed ? "TRACK_CHANGED" : previousIdentity ? "TRACK_RELOADED" : "TRACK_READY", {
        previousIdentity,
        changed
      });
    }

    play({ positionSeconds = this.positionSeconds, restart = false } = {}) {
      const previous = this.state;
      this.positionSeconds = Math.max(0, Number(positionSeconds) || 0);
      this.state = TransportState.PLAYING;
      const type = restart || previous === TransportState.ENDED
        ? "RESTARTED"
        : previous === TransportState.PAUSED
          ? "RESUMED"
          : "STARTED";
      return this.emit(type, { previousTransport: previous });
    }

    pause({ positionSeconds = this.positionSeconds } = {}) {
      if (this.state === TransportState.DISCONNECTED || this.state === TransportState.ENDED) return null;
      this.positionSeconds = Math.max(0, Number(positionSeconds) || 0);
      this.state = TransportState.PAUSED;
      return this.emit("PAUSED", { preserveTrackPool: true });
    }

    finish({ positionSeconds = this.positionSeconds } = {}) {
      this.positionSeconds = Math.max(0, Number(positionSeconds) || 0);
      this.state = TransportState.ENDED;
      return this.emit("FINISHED", { preserveTrackPool: true });
    }

    restart() {
      const previous = this.state;
      this.positionSeconds = 0;
      this.state = TransportState.PLAYING;
      return this.emit("RESTARTED", { previousTransport: previous, preserveTrackPool: true });
    }

    updatePosition(positionSeconds) {
      this.positionSeconds = Math.max(0, Number(positionSeconds) || 0);
    }

    updateTrackMetadata(track = {}) {
      this.track = { ...(this.track || {}), ...track };
      return this.track;
    }

    disconnect() {
      const previousIdentity = this.identity;
      this.state = TransportState.DISCONNECTED;
      this.track = null;
      this.identity = "";
      this.positionSeconds = 0;
      return this.emit("DISCONNECTED", { previousIdentity });
    }

    snapshot() {
      return {
        connected: this.state !== TransportState.DISCONNECTED,
        transport: this.state,
        track: this.track,
        identity: this.identity,
        positionSeconds: this.positionSeconds,
        lastEvent: this.lastEvent ? { ...this.lastEvent } : null
      };
    }
  }

  return { TransportState, Controller, trackIdentity };
});
