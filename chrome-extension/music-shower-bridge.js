(function initializeMusicShowerBridge() {
const EXTENSION_SOURCE = "music-shower-extension";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

function forward(message) {
  window.postMessage({ source: EXTENSION_SOURCE, ...message }, location.origin);
}

forward({ type: "EXTENSION_READY", version: EXTENSION_VERSION });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MUSIC_SHOWER_BRIDGE_PING") {
    sendResponse({ ok: true, version: EXTENSION_VERSION });
    return;
  }
  if (message?.type === "MUSIC_SHOWER_ATTACH_SOUNDCLOUD_DIRECT") {
    forward({
      type: "ATTACH_SOUNDCLOUD_TAB",
      transport: "stream-id",
      streamId: message.streamId || "",
      connectionId: message.connectionId,
      sourceTabId: message.sourceTabId,
      sourceUrl: message.sourceUrl
    });
  } else if (message?.type === "MUSIC_SHOWER_ATTACH_SOUNDCLOUD_RTC") {
    forward({
      type: "ATTACH_SOUNDCLOUD_TAB",
      transport: "webrtc",
      offer: message.offer || null,
      connectionId: message.connectionId,
      sourceTabId: message.sourceTabId,
      sourceUrl: message.sourceUrl
    });
  } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_EVENT") {
    forward({ type: "SOUNDCLOUD_EVENT", event: message.event });
  } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_ENDED") {
    forward({ type: "CAPTURE_ENDED", reason: message.reason });
  } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_FAILED") {
    forward({ type: "CAPTURE_FAILED", error: message.error || "탭 오디오 캡처 실패" });
  }
});

window.addEventListener("message", event => {
  if (event.source !== window || event.data?.source !== "music-shower-page") return;
  if (event.data.type === "SOUNDCLOUD_PING") {
    return forward({ type: "EXTENSION_READY", version: EXTENSION_VERSION });
  }
  if (event.data.type === "SOUNDCLOUD_ATTACH_RESULT") {
    chrome.runtime.sendMessage({
      type: "MUSIC_SHOWER_ATTACH_RESULT",
      connectionId: event.data.connectionId,
      ok: Boolean(event.data.ok),
      error: event.data.error || "",
      audioContextState: event.data.audioContextState || "unknown",
      audioTrackState: event.data.audioTrackState || "unknown"
    }).catch(() => {});
    return;
  }
  if (event.data.type === "SOUNDCLOUD_AUDIO_FLOW") {
    chrome.runtime.sendMessage({
      type: "MUSIC_SHOWER_AUDIO_FLOW",
      connectionId: event.data.connectionId
    }).catch(() => {});
    return;
  }
  if (event.data.type === "SOUNDCLOUD_RTC_ANSWER") {
    chrome.runtime.sendMessage({
      type: "MUSIC_SHOWER_RTC_ANSWER",
      connectionId: event.data.connectionId,
      answer: event.data.answer
    }).catch(() => {});
    return;
  }
  if (event.data.type === "SOUNDCLOUD_CONNECTION_CLOSED") {
    chrome.runtime.sendMessage({
      type: "MUSIC_SHOWER_CONNECTION_CLOSED",
      connectionId: event.data.connectionId,
      reason: event.data.reason || "ended"
    }).catch(() => {});
    return;
  }
  if (event.data.type !== "SOUNDCLOUD_COMMAND") return;
  chrome.runtime.sendMessage({
    type: "MUSIC_SHOWER_SOUNDCLOUD_COMMAND",
    command: event.data.command,
    url: event.data.url || null
  }).catch(() => {});
});
})();
