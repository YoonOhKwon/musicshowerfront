(() => {
  const PAGE_SOURCE = "music-shower-soundcloud-page";
  // Commands this page understands; the Music Shower player enables only these buttons.
  const CAPABILITIES = ["PLAY", "PAUSE", "RESTART", "SEEK", "NEXT", "PREVIOUS", "VOLUME_UP", "VOLUME_DOWN", "SHUFFLE", "REPEAT"];
  const VOLUME_STEP = 0.1;
  let lastIdentity = "";
  let lastTransport = "";
  let lastControls = "";
  let lastPosition = 0;
  let lastProgressSentAt = 0;

  // SoundCloud plays through an Audio element that is never attached to the document, so
  // document queries and capture listeners miss it. Register every element that plays.
  const knownMedia = new Set();
  let lastPlayedMedia = null;
  const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "seeked", "loadedmetadata", "durationchange", "volumechange"];

  function trackMedia(element) {
    if (!element || knownMedia.has(element)) return;
    knownMedia.add(element);
    for (const type of MEDIA_EVENTS) {
      element.addEventListener(type, () => publish({ force: type === "loadedmetadata" }));
    }
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    trackMedia(this);
    lastPlayedMedia = this;
    return nativePlay.apply(this, args);
  };

  // The page's own media-session handlers skip and seek through SoundCloud's queue, which
  // keeps its UI consistent. Keep a reference so commands can reuse them.
  const actionHandlers = new Map();
  if (globalThis.MediaSession?.prototype?.setActionHandler) {
    const nativeSetActionHandler = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function setActionHandler(action, handler) {
      if (typeof handler === "function") actionHandlers.set(action, handler);
      else actionHandlers.delete(action);
      return nativeSetActionHandler.call(this, action, handler);
    };
  }

  function mediaElement() {
    const elements = [...new Set([...knownMedia, ...document.querySelectorAll("audio, video")])];
    return elements.find(element => !element.paused && !element.ended)
      || (lastPlayedMedia && elements.includes(lastPlayedMedia) ? lastPlayedMedia : null)
      || elements[0] || null;
  }

  function query(selector) {
    return document.querySelector(selector);
  }

  function clickControl(selector) {
    const control = query(selector);
    if (!control || control.disabled || control.classList.contains("disabled")) return false;
    control.click();
    return true;
  }

  function runAction(action, details = {}) {
    const handler = actionHandlers.get(action);
    if (!handler) return false;
    try {
      handler({ action, ...details });
      return true;
    } catch {
      return false;
    }
  }

  function parseClock(text = "") {
    const parts = String(text).trim().split(":").map(Number);
    if (parts.length < 2 || !parts.every(Number.isFinite)) return 0;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  }

  function badgeArtwork() {
    const image = query(".playbackSoundBadge .sc-artwork span, .playbackSoundBadge span.sc-artwork")?.style.backgroundImage || "";
    const url = image.match(/url\(["']?([^"')]+)["']?\)/)?.[1] || "";
    // The badge shows the small thumbnail; SoundCloud serves the same image at larger sizes.
    return url.replace(/-t\d+x\d+(\.\w+)$/, "-t200x200$1");
  }

  function badgePermalink() {
    const href = query(".playbackSoundBadge__titleLink")?.getAttribute("href") || "";
    if (!href) return "";
    try {
      const url = new URL(href, location.origin);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return "";
    }
  }

  function repeatMode() {
    const control = query(".repeatControl");
    if (!control) return "unknown";
    if (control.classList.contains("m-one")) return "one";
    if (control.classList.contains("m-all")) return "all";
    return "none";
  }

  function currentSnapshot() {
    const media = mediaElement();
    const metadata = navigator.mediaSession?.metadata || null;
    const permalink = badgePermalink();
    const badgeTitle = query(".playbackSoundBadge__titleLink")?.getAttribute("title") || "";
    const badgeArtist = query(".playbackSoundBadge__lightLink")?.textContent?.trim() || "";
    const title = String(metadata?.title || badgeTitle || "");
    const artist = String(metadata?.artist || badgeArtist || "");
    const album = String(metadata?.album || "");
    const artwork = Array.isArray(metadata?.artwork) ? metadata.artwork.at(-1)?.src || "" : "";
    // Identify the track that is playing, not the page being browsed: SoundCloud keeps
    // playing while the user navigates, and related tracks start from any page.
    const identity = permalink
      || (title ? `${artist.toLocaleLowerCase()}␟${title.toLocaleLowerCase()}` : "");
    const playbackState = navigator.mediaSession?.playbackState;
    const transport = media?.ended ? "finished"
      : media ? (media.paused ? "paused" : "playing")
        : playbackState === "playing" ? "playing"
          : playbackState === "paused" ? "paused" : "unknown";
    const mediaDuration = Number(media?.duration);
    const volumeSlider = Number(query(".volume__sliderWrapper")?.getAttribute("aria-valuenow"));
    const shuffleControl = query(".shuffleControl");
    return {
      identity,
      title,
      artist,
      album,
      artworkUrl: artwork || badgeArtwork(),
      permalinkUrl: permalink || (identity ? location.href : ""),
      positionSeconds: media
        ? Math.max(0, Number(media.currentTime) || 0)
        : parseClock(query(".playbackTimeline__timePassed span[aria-hidden]")?.textContent),
      durationSeconds: Number.isFinite(mediaDuration) && mediaDuration > 0
        ? mediaDuration
        : parseClock(query(".playbackTimeline__duration span[aria-hidden]")?.textContent),
      transport,
      volume: media ? Math.round(media.volume * 100) / 100 : Number.isFinite(volumeSlider) ? volumeSlider : null,
      shuffle: shuffleControl ? shuffleControl.classList.contains("m-shuffling") : null,
      repeat: repeatMode(),
      capabilities: CAPABILITIES
    };
  }

  function emit(type, snapshot = currentSnapshot()) {
    window.postMessage({
      source: PAGE_SOURCE,
      event: { type, ...snapshot, observedAt: Date.now() }
    }, location.origin);
  }

  function publish({ force = false } = {}) {
    const snapshot = currentSnapshot();
    if (force || snapshot.identity !== lastIdentity) {
      lastIdentity = snapshot.identity;
      emit("TRACK", snapshot);
    }
    if (snapshot.transport !== "unknown" && (force || snapshot.transport !== lastTransport)) {
      lastTransport = snapshot.transport;
      emit(snapshot.transport === "playing" ? "PLAY" : snapshot.transport === "finished" ? "FINISH" : "PAUSE", snapshot);
    }
    if (lastPosition > 20 && snapshot.positionSeconds < 2 && snapshot.transport === "playing") emit("RESTART", snapshot);
    lastPosition = snapshot.positionSeconds;
    // Volume, shuffle and repeat have no media event of their own.
    const controls = `${snapshot.volume}|${snapshot.shuffle}|${snapshot.repeat}`;
    if (!force && lastControls && controls !== lastControls) emit("STATE", snapshot);
    lastControls = controls;
    if (snapshot.transport === "playing" && Date.now() - lastProgressSentAt >= 1000) {
      lastProgressSentAt = Date.now();
      emit("PROGRESS", snapshot);
    }
  }

  // Report the result of a command once SoundCloud has updated its player.
  function publishSoon() {
    setTimeout(() => publish(), 120);
    setTimeout(() => publish(), 600);
  }

  function setVolume(delta) {
    const media = mediaElement();
    if (!media) return;
    const next = Math.round(Math.min(1, Math.max(0, media.volume + delta)) * 100) / 100;
    for (const element of knownMedia) element.volume = next;
  }

  function seek(positionMs) {
    const media = mediaElement();
    const seconds = Number(positionMs) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const duration = Number(media?.duration);
    const target = Number.isFinite(duration) && duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.25)) : seconds;
    lastPosition = target;
    if (runAction("seekto", { seekTime: target, fastSeek: false })) return;
    if (media) media.currentTime = target;
  }

  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, event => {
      if (event.target instanceof HTMLMediaElement) trackMedia(event.target);
      publish({ force: type === "loadedmetadata" });
    }, true);
  }
  window.addEventListener("popstate", () => setTimeout(() => publish(), 0));
  function observePageTitle() {
    const root = document.head || document.documentElement;
    if (!root) return setTimeout(observePageTitle, 50);
    new MutationObserver(() => publish()).observe(root, { subtree: true, childList: true, characterData: true });
  }
  observePageTitle();
  setInterval(publish, 500);

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "music-shower-extension") return;
    if (event.data.type === "REQUEST_SNAPSHOT") return publish({ force: true });
    if (event.data.type !== "COMMAND") return;
    const command = String(event.data.command || "").toUpperCase();
    if (command === "REQUEST_SNAPSHOT") return publish({ force: true });
    const media = mediaElement();
    if (command === "PLAY") {
      if (media) media.play?.().catch(() => {});
      else if (!runAction("play")) clickControl(".playControls__play:not(.playing)");
    } else if (command === "PAUSE") {
      if (media) media.pause?.();
      else if (!runAction("pause")) clickControl(".playControls__play.playing");
    } else if (command === "RESTART" && media) {
      lastPosition = 0;
      media.currentTime = 0;
      media.play?.().catch(() => {});
      emit("RESTART");
    } else if (command === "SEEK") {
      seek(event.data.positionMs);
    } else if (command === "NEXT") {
      if (!clickControl(".skipControl__next")) runAction("nexttrack");
    } else if (command === "PREVIOUS") {
      if (!clickControl(".skipControl__previous")) runAction("previoustrack");
    } else if (command === "VOLUME_UP" || command === "VOLUME_DOWN") {
      setVolume(command === "VOLUME_UP" ? VOLUME_STEP : -VOLUME_STEP);
    } else if (command === "SHUFFLE") {
      clickControl(".shuffleControl");
    } else if (command === "REPEAT") {
      clickControl(".repeatControl");
    } else if (command === "LOAD_URL") {
      try {
        const url = new URL(String(event.data.url || ""));
        if (url.protocol === "https:" && ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(url.hostname)) location.assign(url.href);
      } catch { /* invalid commands are ignored in the SoundCloud page */ }
      return;
    } else {
      return;
    }
    publishSoon();
  });
})();
