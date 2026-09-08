(() => {
  const PAGE_SOURCE = "music-shower-soundcloud-page";
  let lastIdentity = "";
  let lastTransport = "";
  let lastPosition = 0;
  let lastProgressSentAt = 0;

  function mediaElement() {
    const elements = [...document.querySelectorAll("audio, video")];
    return elements.find(element => !element.paused && !element.ended) || elements[0] || null;
  }

  function cleanedDocumentTitle() {
    return String(document.title || "")
      .replace(/\s*[|·-]\s*SoundCloud\s*$/i, "")
      .replace(/^Stream\s+/, "")
      .trim();
  }

  function currentSnapshot() {
    const media = mediaElement();
    const metadata = navigator.mediaSession?.metadata || null;
    const title = String(metadata?.title || cleanedDocumentTitle() || "SoundCloud 트랙");
    const artist = String(metadata?.artist || "SoundCloud");
    const album = String(metadata?.album || "");
    const artwork = Array.isArray(metadata?.artwork) ? metadata.artwork.at(-1)?.src || "" : "";
    const pathParts = location.pathname.split("/").filter(Boolean);
    const genericRoute = new Set(["discover", "stream", "search", "you", "charts"]);
    const trackPage = pathParts.length >= 2 && !genericRoute.has(pathParts[0]);
    const identity = trackPage
      ? `${location.origin}${location.pathname.replace(/\/+$/, "")}`
      : title && title !== "SoundCloud 트랙"
        ? `${artist.toLocaleLowerCase()}\u241f${title.toLocaleLowerCase()}`
        : `${location.origin}${location.pathname}`;
    const playbackState = navigator.mediaSession?.playbackState;
    const transport = media?.ended ? "finished"
      : media ? (media.paused ? "paused" : "playing")
        : playbackState === "playing" ? "playing"
          : playbackState === "paused" ? "paused" : "unknown";
    return {
      identity,
      title,
      artist,
      album,
      artworkUrl: artwork,
      permalinkUrl: location.href,
      positionSeconds: Math.max(0, Number(media?.currentTime) || 0),
      durationSeconds: Math.max(0, Number(media?.duration) || 0),
      transport
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
    if (force || (snapshot.identity && snapshot.identity !== lastIdentity)) {
      lastIdentity = snapshot.identity;
      emit("TRACK", snapshot);
    }
    if (snapshot.transport !== "unknown" && (force || snapshot.transport !== lastTransport)) {
      lastTransport = snapshot.transport;
      emit(snapshot.transport === "playing" ? "PLAY" : snapshot.transport === "finished" ? "FINISH" : "PAUSE", snapshot);
    }
    if (lastPosition > 20 && snapshot.positionSeconds < 2 && snapshot.transport === "playing") emit("RESTART", snapshot);
    lastPosition = snapshot.positionSeconds;
    if (snapshot.transport === "playing" && Date.now() - lastProgressSentAt >= 1000) {
      lastProgressSentAt = Date.now();
      emit("PROGRESS", snapshot);
    }
  }

  for (const type of ["play", "playing", "pause", "ended", "seeked", "loadedmetadata", "durationchange"]) {
    document.addEventListener(type, () => publish({ force: type === "loadedmetadata" }), true);
  }
  window.addEventListener("popstate", () => setTimeout(() => publish({ force: true }), 0));
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
    if (event.data.command === "REQUEST_SNAPSHOT") return publish({ force: true });
    const media = mediaElement();
    if (event.data.command === "PLAY") media?.play?.().catch(() => {});
    else if (event.data.command === "PAUSE") media?.pause?.();
    else if (event.data.command === "RESTART" && media) {
      lastPosition = 0;
      media.currentTime = 0;
      media.play?.().catch(() => {});
      emit("RESTART");
    } else if (event.data.command === "LOAD_URL") {
      try {
        const url = new URL(String(event.data.url || ""));
        if (url.protocol === "https:" && ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(url.hostname)) location.assign(url.href);
      } catch { /* invalid commands are ignored in the SoundCloud page */ }
    }
  });
})();
