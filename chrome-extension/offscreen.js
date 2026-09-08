let captureStream = null;
let peerConnection = null;
let activeConnectionId = "";
let monitorContext = null;
let monitorSource = null;

function descriptionJson(description) {
  return description ? { type: description.type, sdp: description.sdp } : null;
}

function waitForIceGathering(connection, timeoutMs = 2500) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      connection.removeEventListener("icegatheringstatechange", check);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    connection.addEventListener("icegatheringstatechange", check);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function stopCapture() {
  const connection = peerConnection;
  peerConnection = null;
  connection?.close();
  try {
    monitorSource?.disconnect();
  } catch { /* already disconnected */ }
  monitorSource = null;
  const context = monitorContext;
  monitorContext = null;
  if (context && context.state !== "closed") await context.close().catch(() => {});
  captureStream?.getTracks().forEach(track => track.stop());
  captureStream = null;
  activeConnectionId = "";
}

async function reportCaptureEnded(connectionId, reason) {
  if (!connectionId || connectionId !== activeConnectionId) return;
  await chrome.runtime.sendMessage({
    type: "MUSIC_SHOWER_OFFSCREEN_CAPTURE_ENDED",
    connectionId,
    reason
  }).catch(() => {});
}

async function startCapture(message) {
  await stopCapture();
  activeConnectionId = String(message.connectionId || "");
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });

  const [audioTrack] = captureStream.getAudioTracks();
  if (!audioTrack || audioTrack.readyState !== "live") {
    throw new Error("SoundCloud 탭의 오디오 트랙을 시작하지 못했습니다.");
  }
  monitorContext = new AudioContext({ latencyHint: "interactive" });
  monitorSource = monitorContext.createMediaStreamSource(captureStream);
  monitorSource.connect(monitorContext.destination);
  if (monitorContext.state === "suspended") await monitorContext.resume();
  audioTrack.addEventListener("ended", () => {
    const connectionId = activeConnectionId;
    reportCaptureEnded(connectionId, "media_stream_track_ended").finally(() => stopCapture());
  }, { once: true });

  peerConnection = new RTCPeerConnection({ iceServers: [] });
  captureStream.getTracks().forEach(track => peerConnection.addTrack(track, captureStream));
  peerConnection.addEventListener("connectionstatechange", () => {
    if (["failed", "closed"].includes(peerConnection?.connectionState)) {
      reportCaptureEnded(activeConnectionId, `rtc_${peerConnection?.connectionState || "closed"}`);
    }
  });

  await peerConnection.setLocalDescription(await peerConnection.createOffer());
  await waitForIceGathering(peerConnection);
  await chrome.runtime.sendMessage({
    type: "MUSIC_SHOWER_OFFSCREEN_OFFER",
    connectionId: activeConnectionId,
    offer: descriptionJson(peerConnection.localDescription)
  });
}

async function acceptAnswer(message) {
  if (!peerConnection || String(message.connectionId || "") !== activeConnectionId) return;
  await peerConnection.setRemoteDescription(message.answer);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "music-shower-offscreen") return;
  (async () => {
    if (message.type === "MUSIC_SHOWER_OFFSCREEN_PING") return;
    if (message.type === "MUSIC_SHOWER_START_CAPTURE") await startCapture(message);
    if (message.type === "MUSIC_SHOWER_RTC_ANSWER") await acceptAnswer(message);
    if (message.type === "MUSIC_SHOWER_STOP_CAPTURE") await stopCapture();
  })().then(() => sendResponse({ ok: true })).catch(async error => {
    const connectionId = String(message?.connectionId || activeConnectionId || "");
    await stopCapture();
    await chrome.runtime.sendMessage({
      type: "MUSIC_SHOWER_OFFSCREEN_CAPTURE_FAILED",
      connectionId,
      error: `${error?.name || "Error"}: ${error?.message || "탭 오디오 캡처 실패"}`
    }).catch(() => {});
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});
