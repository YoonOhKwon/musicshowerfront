const test = require("node:test");
const assert = require("node:assert/strict");

const SoundCloudLifecycle = require("../js/audio/soundCloudLifecycle");
const TrackLifecycleEngine = require("../js/semantic/trackLifecycleEngine");
const fs = require("node:fs");
const path = require("node:path");

test("the no-key SoundCloud path uses a Chrome tab bridge with event forwarding", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const audioEngine = fs.readFileSync(path.join(root, "js/audio/audioEngine.js"), "utf8");
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
  const background = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
  const offscreen = fs.readFileSync(path.join(root, "chrome-extension/offscreen.js"), "utf8");
  const musicShowerBridge = fs.readFileSync(path.join(root, "chrome-extension/music-shower-bridge.js"), "utf8");
  const soundCloudPage = fs.readFileSync(path.join(root, "chrome-extension/soundcloud-page.js"), "utf8");
  assert.doesNotMatch(html, /w\.soundcloud\.com\/player/);
  assert.ok(manifest.permissions.includes("tabCapture"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.match(background, /chrome\.tabCapture\.getMediaStreamId/);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /ensureConsumerBridge/);
  assert.match(background, /resolveSoundCloudSourceTab/);
  assert.match(background, /notifyConsumerTabs/);
  assert.match(background, /waitForCaptureRelease/);
  assert.match(background, /chrome\.offscreen\.closeDocument/);
  assert.match(background, /chrome\.runtime\.onInstalled/);
  assert.match(background, /getMediaStreamId\(\{[^}]*consumerTabId/);
  assert.match(background, /MUSIC_SHOWER_ATTACH_SOUNDCLOUD_DIRECT/);
  assert.match(background, /fallbackToOffscreen/);
  assert.match(background, /watchDirectAttach/);
  assert.match(offscreen, /chromeMediaSourceId:\s*message\.streamId/);
  assert.match(offscreen, /RTCPeerConnection/);
  assert.match(offscreen, /monitorSource\.connect\(monitorContext\.destination\)/);
  assert.match(soundCloudPage, /navigator\.mediaSession/);
  assert.match(audioEngine, /chromeMediaSourceId:\s*message\.streamId/);
  assert.match(audioEngine, /receiveSoundCloudWebRtcStream/);
  assert.match(audioEngine, /receiveSoundCloudDirectStream/);
  assert.match(audioEngine, /resumeSoundCloudAnalysis/);
  assert.match(audioEngine, /startSoundCloudTabShare/);
  assert.match(audioEngine, /SoundCloud 탭 직접 선택/);
  assert.match(audioEngine, /SoundCloud 오디오 감지됨/);
  assert.match(musicShowerBridge, /SOUNDCLOUD_RTC_ANSWER/);
  assert.match(musicShowerBridge, /transport:\s*"stream-id"/);
  assert.match(musicShowerBridge, /MUSIC_SHOWER_BRIDGE_PING/);
  assert.match(audioEngine, /monitor:\s*message\.transport\s*!==\s*"webrtc"/);
  assert.match(background, /MUSIC_SHOWER_ATTACH_RESULT/);
  assert.match(background, /phase:\s*"attached"/);
  assert.match(musicShowerBridge, /SOUNDCLOUD_ATTACH_RESULT/);
  assert.match(audioEngine, /SOUNDCLOUD_AUDIO_FLOW/);
  assert.match(audioEngine, /audioFlowConfirmed/);
  assert.doesNotMatch(envExample, /SOUNDCLOUD_CLIENT_(ID|SECRET)/);
});

test("pause, finish, resume, and restart preserve one SoundCloud track pool indefinitely", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  let removedCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };
  lifecycle.onAudioRemoved = () => { removedCount += 1; };

  const transport = new SoundCloudLifecycle.Controller({
    onEvent(event) {
      if (event.type === "TRACK_CHANGED") lifecycle.resetForNewTrack("soundcloud_track_changed");
      if (event.type === "PAUSED" || event.type === "FINISHED") lifecycle.freezeForPause();
      if (event.type === "RESUMED" || event.type === "RESTARTED") lifecycle.resumeSameTrack();
      if (event.type === "STARTED") lifecycle.tickAuthoritative({ isPlaying: true, now: 1000 });
    }
  });

  transport.loadTrack({ urn: "soundcloud:tracks:1", title: "A" });
  transport.play();
  const epoch = lifecycle.getTrackEpoch();
  transport.pause({ positionSeconds: 12 });
  lifecycle.tickAuthoritative({ isPlaying: false, now: 3600000 });
  assert.equal(lifecycle.getState(), "PAUSED");
  assert.equal(lifecycle.getTrackEpoch(), epoch);
  assert.equal(removedCount, 0, "an arbitrarily long API pause must never become AUDIO_REMOVED");

  transport.play({ positionSeconds: 12 });
  transport.finish({ positionSeconds: 180 });
  transport.restart();
  assert.equal(lifecycle.getTrackEpoch(), epoch);
  assert.equal(resetCount, 0, "same-track transport actions must preserve the Flamingo pool");
});

test("loading a different SoundCloud track URL resets the track exactly once", () => {
  const events = [];
  const transport = new SoundCloudLifecycle.Controller({ onEvent: event => events.push(event.type) });
  transport.loadTrack({ urn: "soundcloud:tracks:1" });
  transport.loadTrack({ urn: "soundcloud:tracks:1" });
  transport.loadTrack({ urn: "soundcloud:tracks:2" });
  assert.deepEqual(events, ["TRACK_READY", "TRACK_RELOADED", "TRACK_CHANGED"]);
});
