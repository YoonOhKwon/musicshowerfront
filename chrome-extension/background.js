const CONNECTION_KEY = "musicShowerSoundCloudConnection";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument = null;
const connectingSourceTabs = new Set();
const MUSIC_SHOWER_URLS = [
  "http://localhost:3000/*",
  "http://127.0.0.1:3000/*",
  "http://localhost:5173/*",
  "http://127.0.0.1:5173/*"
];

function isSoundCloudUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function resolveSoundCloudSourceTab(clickedTab) {
  if (clickedTab?.id && isSoundCloudUrl(clickedTab.url)) return clickedTab;
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(tab => tab.id && isSoundCloudUrl(tab.url))
    .sort((a, b) => {
      const activeDifference = Number(Boolean(b.active)) - Number(Boolean(a.active));
      if (activeDifference) return activeDifference;
      return Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
    })[0] || null;
}

async function notifyConsumerTabs(tabs, error) {
  await Promise.all(tabs.filter(tab => tab?.id).map(tab => chrome.tabs.sendMessage(tab.id, {
    type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_FAILED",
    error
  }).catch(() => {})));
}

async function connection() {
  return (await chrome.storage.session.get(CONNECTION_KEY))[CONNECTION_KEY] || null;
}

const METADATA_SOURCE_KEY = "musicShowerSoundCloudMetadataSource";

async function metadataSourceTabId() {
  return (await chrome.storage.session.get(METADATA_SOURCE_KEY))[METADATA_SOURCE_KEY] || null;
}

// Without a connection, the tab that is playing owns the player; a paused tab only reports
// when no other SoundCloud tab has claimed it.
async function claimMetadataSource(tabId, event) {
  const current = await metadataSourceTabId();
  if (current === tabId) return true;
  if (current && event?.transport !== "playing") {
    const currentTab = await chrome.tabs.get(current).catch(() => null);
    if (currentTab && isSoundCloudUrl(currentTab.url)) return false;
  }
  await chrome.storage.session.set({ [METADATA_SOURCE_KEY]: tabId });
  return true;
}

async function setBadge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}

async function setConnectionBadge(tabId, text, color, title) {
  await setBadge(tabId, text, color);
  if (title) await chrome.action.setTitle({ tabId, title });
}

function createConnectionId(sourceTabId, consumerTabId) {
  return `${sourceTabId}:${consumerTabId}:${Date.now()}:${crypto.randomUUID()}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToOffscreen(message, attempts = 1) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage({ target: "music-shower-offscreen", ...message });
    } catch (error) {
      lastError = error;
      if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
      await delay(80);
    }
  }
  throw lastError || new Error("Music Shower 숨은 오디오 처리기를 시작하지 못했습니다.");
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "SoundCloud 탭 오디오를 Music Shower 분석기로 전달합니다."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
  await sendToOffscreen({ type: "MUSIC_SHOWER_OFFSCREEN_PING" }, 25);
}

async function stopOffscreenCapture(connectionId) {
  await sendToOffscreen({
    type: "MUSIC_SHOWER_STOP_CAPTURE",
    connectionId
  }).catch(() => {});
}

async function closeOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (!contexts.length) return;
  await chrome.offscreen.closeDocument().catch(() => {});
  creatingOffscreenDocument = null;
}

async function ensureConsumerBridge(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "MUSIC_SHOWER_BRIDGE_PING" });
    if (response?.version === chrome.runtime.getManifest().version) return;
  } catch { /* inject the bridge below */ }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["music-shower-bridge.js"]
  });
  const response = await chrome.tabs.sendMessage(tabId, { type: "MUSIC_SHOWER_BRIDGE_PING" });
  if (response?.version !== chrome.runtime.getManifest().version) {
    throw new Error("3D 프론트 연결 스크립트를 준비하지 못했습니다. 3D 프론트를 새로고침해 주세요.");
  }
}

async function waitForCaptureRelease(sourceTabId, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const capturedTabs = await chrome.tabCapture.getCapturedTabs();
    if (!capturedTabs.some(info => info.tabId === sourceTabId && ["pending", "active"].includes(info.status))) {
      return true;
    }
    await delay(100);
  }
  return false;
}

async function releasePreviousCapture(sourceTabId, consumerTabs) {
  const previous = await connection();
  const connectionId = previous?.connectionId || "";
  for (const tab of consumerTabs) {
    await chrome.tabs.sendMessage(tab.id, {
      type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_ENDED",
      reason: "reconnect_requested"
    }).catch(() => {});
  }
  await stopOffscreenCapture(connectionId);
  await closeOffscreenDocument();
  await chrome.storage.session.remove(CONNECTION_KEY);
  return waitForCaptureRelease(sourceTabId);
}

async function fallbackToOffscreen(expectedConnectionId, reason = "direct_attach_timeout") {
  const directState = await connection();
  if (!directState || directState.connectionId !== expectedConnectionId || directState.phase !== "attaching_direct") return;

  const startingState = {
    ...directState,
    phase: "starting_offscreen",
    fallbackReason: reason,
    fallbackParentConnectionId: expectedConnectionId
  };
  await chrome.storage.session.set({ [CONNECTION_KEY]: startingState });
  await setConnectionBadge(directState.sourceTabId, "RTC", "#7c3aed", "직접 연결이 지연되어 호환 연결로 전환 중");
  await chrome.tabs.sendMessage(directState.consumerTabId, {
    type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_ENDED",
    reason: "direct_fallback"
  }).catch(() => {});
  await waitForCaptureRelease(directState.sourceTabId, 3000);
  await ensureOffscreenDocument();

  const connectionId = createConnectionId(directState.sourceTabId, directState.consumerTabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: directState.sourceTabId
  });
  const fallbackState = {
    ...directState,
    connectionId,
    phase: "capturing_offscreen",
    fallbackParentConnectionId: expectedConnectionId,
    fallbackStartedAt: Date.now()
  };
  await chrome.storage.session.set({ [CONNECTION_KEY]: fallbackState });
  await sendToOffscreen({
    type: "MUSIC_SHOWER_START_CAPTURE",
    streamId,
    connectionId,
    sourceTabId: fallbackState.sourceTabId,
    sourceUrl: fallbackState.sourceUrl
  }, 5);
}

async function watchDirectAttach(connectionId) {
  await delay(6000);
  try {
    await fallbackToOffscreen(connectionId);
  } catch (error) {
    const state = await connection();
    if (!state || (state.connectionId !== connectionId && state.fallbackParentConnectionId !== connectionId)) return;
    console.error("Music Shower compatibility fallback failed:", error);
    await chrome.storage.session.remove(CONNECTION_KEY);
    await notifyConsumerTabs([{ id: state.consumerTabId }], error?.message || "호환 오디오 연결 실패");
    await setConnectionBadge(state.sourceTabId, "ERR", "#b42318", `Music Shower 호환 연결 실패: ${error?.message || "알 수 없는 오류"}`);
  }
}

async function connectSoundCloudTab(clickedTab) {
  const sourceTab = await resolveSoundCloudSourceTab(clickedTab);
  if (!sourceTab?.id) {
    if (clickedTab?.id) {
      await setConnectionBadge(
        clickedTab.id,
        "SC?",
        "#b42318",
        "열려 있는 SoundCloud 탭을 찾지 못했습니다. SoundCloud를 먼저 열어 주세요."
      );
    }
    return;
  }

  if (connectingSourceTabs.has(sourceTab.id)) {
    await setConnectionBadge(sourceTab.id, "…", "#7c3aed", "Music Shower 오디오 연결이 이미 진행 중입니다.");
    return;
  }
  connectingSourceTabs.add(sourceTab.id);

  const candidates = await chrome.tabs.query({ url: MUSIC_SHOWER_URLS });
  const consumerTab = candidates.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
  if (!consumerTab?.id) {
    await setBadge(sourceTab.id, "APP", "#b42318");
    await chrome.tabs.create({ url: "http://localhost:3000" });
    connectingSourceTabs.delete(sourceTab.id);
    return;
  }

  try {
    const connectionId = createConnectionId(sourceTab.id, consumerTab.id);
    await setConnectionBadge(sourceTab.id, "…", "#7c3aed", "Music Shower 오디오 연결 확인 중");
    const released = await releasePreviousCapture(sourceTab.id, candidates);
    if (!released) {
      throw new Error("이 SoundCloud 탭에 이전 오디오 연결이 남아 있습니다. SoundCloud 탭을 완전히 닫고 새 탭으로 다시 열어 주세요.");
    }
    await ensureConsumerBridge(consumerTab.id);
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: sourceTab.id,
      consumerTabId: consumerTab.id
    });
    const state = {
      sourceTabId: sourceTab.id,
      consumerTabId: consumerTab.id,
      connectionId,
      phase: "attaching_direct",
      connectedAt: Date.now(),
      sourceUrl: sourceTab.url
    };
    await chrome.storage.session.set({ [CONNECTION_KEY]: state });
    await chrome.tabs.sendMessage(consumerTab.id, {
      type: "MUSIC_SHOWER_ATTACH_SOUNDCLOUD_DIRECT",
      transport: "stream-id",
      streamId,
      connectionId,
      sourceTabId: sourceTab.id,
      sourceUrl: sourceTab.url
    });
    await chrome.tabs.update(consumerTab.id, { active: true });
    watchDirectAttach(connectionId);
  } catch (error) {
    console.error("Music Shower SoundCloud connection failed:", error);
    await chrome.storage.session.remove(CONNECTION_KEY);
    await notifyConsumerTabs(candidates, error?.message || "알 수 없는 오디오 연결 오류");
    await setConnectionBadge(
      sourceTab.id,
      "ERR",
      "#b42318",
      `Music Shower 연결 실패: ${error?.message || "알 수 없는 오류"}`
    );
  } finally {
    connectingSourceTabs.delete(sourceTab.id);
  }
}

chrome.action.onClicked.addListener(connectSoundCloudTab);

async function resetExtensionState() {
  await chrome.storage.session.remove([CONNECTION_KEY, METADATA_SOURCE_KEY]);
  await closeOffscreenDocument();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => tab.id).map(async tab => {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Music Shower ${chrome.runtime.getManifest().version} · SoundCloud 탭 연결`
    }).catch(() => {});
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  resetExtensionState().catch(error => console.warn("Music Shower extension reset failed:", error));
});

chrome.runtime.onStartup.addListener(() => {
  resetExtensionState().catch(error => console.warn("Music Shower extension startup reset failed:", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const state = await connection();
    if (message?.type === "MUSIC_SHOWER_OFFSCREEN_OFFER") {
      if (!state || message.connectionId !== state.connectionId) return;
      await ensureConsumerBridge(state.consumerTabId);
      await chrome.tabs.sendMessage(state.consumerTabId, {
        type: "MUSIC_SHOWER_ATTACH_SOUNDCLOUD_RTC",
        transport: "webrtc",
        offer: message.offer,
        connectionId: state.connectionId,
        sourceTabId: state.sourceTabId,
        sourceUrl: state.sourceUrl
      });
      await chrome.tabs.update(state.consumerTabId, { active: true });
    } else if (message?.type === "MUSIC_SHOWER_OFFSCREEN_CAPTURE_FAILED") {
      if (!state || message.connectionId !== state.connectionId) return;
      await setConnectionBadge(
        state.sourceTabId,
        "ERR",
        "#b42318",
        `Music Shower 오디오 연결 실패: ${message.error || "탭 오디오 캡처 실패"}`
      );
      await chrome.tabs.sendMessage(state.consumerTabId, {
        type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_FAILED",
        connectionId: state.connectionId,
        error: message.error || "탭 오디오 캡처 실패"
      }).catch(() => {});
      await chrome.storage.session.remove(CONNECTION_KEY);
    } else if (message?.type === "MUSIC_SHOWER_OFFSCREEN_CAPTURE_ENDED") {
      if (!state || message.connectionId !== state.connectionId) return;
      await chrome.tabs.sendMessage(state.consumerTabId, {
        type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_ENDED",
        reason: message.reason || "capture_ended"
      }).catch(() => {});
      await stopOffscreenCapture(state.connectionId);
      await chrome.storage.session.remove(CONNECTION_KEY);
    } else if (message?.type === "MUSIC_SHOWER_RTC_ANSWER") {
      if (!state || sender.tab?.id !== state.consumerTabId || message.connectionId !== state.connectionId) return;
      await sendToOffscreen({
        type: "MUSIC_SHOWER_RTC_ANSWER",
        connectionId: state.connectionId,
        answer: message.answer
      }, 5);
    } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_EVENT") {
      if (state) {
        if (sender.tab?.id !== state.sourceTabId) return;
        await chrome.tabs.sendMessage(state.consumerTabId, {
          type: "MUSIC_SHOWER_SOUNDCLOUD_EVENT",
          event: message.event
        });
        return;
      }
      // No icon-click connection: the page may be capturing the tab itself (tab sharing),
      // so the playing SoundCloud tab still reports its track to every Music Shower tab.
      if (!sender.tab?.id || !await claimMetadataSource(sender.tab.id, message.event)) return;
      const consumers = await chrome.tabs.query({ url: MUSIC_SHOWER_URLS });
      await Promise.all(consumers.filter(tab => tab.id).map(tab => chrome.tabs.sendMessage(tab.id, {
        type: "MUSIC_SHOWER_SOUNDCLOUD_EVENT",
        event: message.event
      }).catch(() => {})));
    } else if (message?.type === "MUSIC_SHOWER_SOUNDCLOUD_COMMAND") {
      const command = {
        type: "MUSIC_SHOWER_SOUNDCLOUD_COMMAND",
        command: message.command,
        url: message.url || null,
        positionMs: Number.isFinite(message.positionMs) ? message.positionMs : null
      };
      if (state) {
        if (sender.tab?.id !== state.consumerTabId) return;
        await chrome.tabs.sendMessage(state.sourceTabId, command);
        return;
      }
      if (message.command === "REQUEST_SNAPSHOT") {
        // Ask every SoundCloud tab; the playing one (or the current owner) claims the player.
        const tabs = (await chrome.tabs.query({})).filter(tab => tab.id && isSoundCloudUrl(tab.url));
        await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, command).catch(() => {})));
        return;
      }
      const sourceTabId = await metadataSourceTabId();
      if (sourceTabId) await chrome.tabs.sendMessage(sourceTabId, command).catch(() => {});
    } else if (message?.type === "MUSIC_SHOWER_ATTACH_RESULT") {
      if (!state || sender.tab?.id !== state.consumerTabId || message.connectionId !== state.connectionId) return;
      if (!message.ok) {
        if (state.phase === "attaching_direct") {
          await fallbackToOffscreen(state.connectionId, message.error || "direct_attach_failed");
          return;
        }
        await setConnectionBadge(
          state.sourceTabId,
          "ERR",
          "#b42318",
          `Music Shower 오디오 연결 실패: ${message.error || "알 수 없는 오류"}`
        );
        await chrome.storage.session.remove(CONNECTION_KEY);
        await stopOffscreenCapture(state.connectionId);
        return;
      }
      await chrome.storage.session.set({
        [CONNECTION_KEY]: {
          ...state,
          phase: "attached",
          attachedAt: Date.now(),
          audioContextState: message.audioContextState || "unknown",
          audioTrackState: message.audioTrackState || "unknown"
        }
      });
      await setConnectionBadge(state.sourceTabId, "ON", "#ff5500", "Music Shower 오디오 연결 완료");
      await chrome.tabs.sendMessage(state.sourceTabId, { type: "MUSIC_SHOWER_REQUEST_SNAPSHOT" }).catch(() => {});
    } else if (message?.type === "MUSIC_SHOWER_AUDIO_FLOW") {
      if (!state || sender.tab?.id !== state.consumerTabId || message.connectionId !== state.connectionId) return;
      await chrome.storage.session.set({
        [CONNECTION_KEY]: { ...state, phase: "flowing", audioFlowAt: Date.now() }
      });
      await setConnectionBadge(state.sourceTabId, "LIVE", "#16803c", "Music Shower로 실제 오디오 신호가 전달되는 중");
    } else if (message?.type === "MUSIC_SHOWER_CONNECTION_CLOSED") {
      if (!state || sender.tab?.id !== state.consumerTabId || message.connectionId !== state.connectionId) return;
      await chrome.storage.session.remove(CONNECTION_KEY);
      await stopOffscreenCapture(state.connectionId);
      await setConnectionBadge(state.sourceTabId, "", "#ff5500", "이 SoundCloud 탭을 Music Shower에 연결").catch(() => {});
    }
  })().then(() => sendResponse({ ok: true })).catch(error => {
    console.error(error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

// tabCapture.onStatusChanged has only a tab id, not the stream/connection id.
// During reconnect, a late `stopped` event from the old stream can otherwise
// tear down the new stream. The consumer MediaStreamTrack's connection-scoped
// `ended` event reports MUSIC_SHOWER_CONNECTION_CLOSED instead.

chrome.tabs.onRemoved.addListener(async tabId => {
  if (await metadataSourceTabId() === tabId) {
    await chrome.storage.session.remove(METADATA_SOURCE_KEY);
    const consumers = await chrome.tabs.query({ url: MUSIC_SHOWER_URLS });
    await Promise.all(consumers.filter(tab => tab.id).map(tab => chrome.tabs.sendMessage(tab.id, {
      type: "MUSIC_SHOWER_SOUNDCLOUD_EVENT",
      event: { type: "CLOSED", observedAt: Date.now() }
    }).catch(() => {})));
  }
  const state = await connection();
  if (!state || (tabId !== state.sourceTabId && tabId !== state.consumerTabId)) return;
  const otherTabId = tabId === state.sourceTabId ? state.consumerTabId : state.sourceTabId;
  await chrome.tabs.sendMessage(otherTabId, {
    type: "MUSIC_SHOWER_SOUNDCLOUD_CAPTURE_ENDED",
    reason: "tab_closed"
  }).catch(() => {});
  await chrome.storage.session.remove(CONNECTION_KEY);
  await stopOffscreenCapture(state.connectionId);
});
