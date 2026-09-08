const PAGE_SOURCE = "music-shower-soundcloud-page";

window.addEventListener("message", event => {
  if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
  chrome.runtime.sendMessage({
    type: "MUSIC_SHOWER_SOUNDCLOUD_EVENT",
    event: event.data.event
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "MUSIC_SHOWER_REQUEST_SNAPSHOT") {
    window.postMessage({ source: "music-shower-extension", type: "REQUEST_SNAPSHOT" }, location.origin);
  } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_COMMAND") {
    window.postMessage({
      source: "music-shower-extension",
      type: "COMMAND",
      command: message.command,
      url: message.url || null
    }, location.origin);
  }
});
