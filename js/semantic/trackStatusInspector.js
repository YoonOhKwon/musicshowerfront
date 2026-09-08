// TrackStatusInspector ("T" panel): a visual space dedicated to answering two questions --
// does the Deep Listen recording status actually track real audio state (playing / paused /
// same-song resume / genuine track change / stopped)? And what did Music Flamingo actually
// contribute to the word pool, and can you SEE it get cleared out when the track changes?
// Separate from the "D" debug overlay and the "L" language inspector, because verifying THIS
// specific pipeline needs its own always-legible view, not a line buried in a denser panel.
const TrackStatusInspector = (() => {
  let panel = null;
  let timer = null;
  // The reset event this panel has already flashed for -- compared against getLastFlamingoReset()
  // so the banner shows itself again on a NEW reset but a stale timestamp is never re-flashed.
  let lastAnnouncedResetAt = 0;
  const RESET_FLASH_MS = 5000;

  const STATE_LABEL = {
    NO_AUDIO: "오디오 없음",
    LISTENING_NEW: "청취 시작 (0~10초)",
    LISTENING_STABLE: "안정적 청취",
    PAUSE_SUSPECTED: "일시정지 의심 (무음 1.5초 미만)",
    PAUSED: "일시정지 · 기억 보존 중",
    RESUMING: "재개 · 같은 곡으로 확인됨",
    TRACK_CHANGED: "곡 전환 감지 · 초기화됨",
    AUDIO_REMOVED: "오디오 종료로 확정 · 초기화됨"
  };
  const BOUNDARY_LABEL = {
    CONTINUOUS: "연속 재생 중",
    PAUSE_SUSPECTED: "짧은 무음 관측",
    PAUSED: "일시정지 확정",
    RESUMED_FROM_PAUSE: "일시정지 후 같은 곡 재개",
    TRACK_CHANGED: "트랙 경계 감지",
    AUDIO_REMOVED: "무음 지속 · 오디오 종료 판정"
  };
  const RESET_REASON_LABEL = {
    acoustic_discontinuity: "음향 불연속 감지 (곡 전환)",
    persistent_acoustic_identity_change: "지속적인 음색 지문 변화 (곡 전환)",
    acoustic_discontinuity_after_gap: "일시정지 후 다른 곡으로 재개",
    resumed_after_extended_silence: "긴 무음 후 재생 재개",
    silence_exceeded_remove_threshold: "무음 지속 · 오디오 종료 판정",
    audio_removed: "오디오 종료"
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function bar(fraction, width = 24) {
    const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
  }

  function createPanel() {
    panel = element("section", undefined, "trackStatusInspector");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "음원 상태 · Deep Listen 녹화 진행");
    panel.tabIndex = -1;
    const header = element("header");
    header.append(element("h2", "음원 상태 · 녹화 진행"));
    const close = element("button", "닫기 · T");
    close.addEventListener("click", toggle);
    header.append(close);
    panel.append(
      header,
      element("div", "", "trackStatusInspectorBanner"),
      element("pre", "", "trackStatusInspectorBody"),
      element("pre", "", "trackStatusInspectorFlamingo")
    );
    panel.querySelector(".trackStatusInspectorBanner").hidden = true;
    panel.addEventListener("keydown", event => { if (event.key === "Escape") toggle(); });
    document.body.append(panel);
  }

  function renderStatus() {
    const status = typeof getDeepListenStatus === "function" ? getDeepListenStatus() : null;
    const lifecycle = status?.lifecycle;
    const lines = [];

    lines.push("── 음원 상태 감지 ──");
    if (lifecycle) {
      lines.push(`상태: ${STATE_LABEL[lifecycle.state] || lifecycle.state}`);
      lines.push(`trackEpoch ${lifecycle.trackEpoch} · sectionEpoch ${lifecycle.sectionEpoch}`);
      lines.push(`무음 지속 ${(lifecycle.silenceDurationMs / 1000).toFixed(1)}초 · 누적 청취시간 ${(lifecycle.activeAudioMs / 1000).toFixed(1)}초`);
      lines.push(`마지막 경계 판정: ${lifecycle.lastBoundaryReason || "--"}`);
      lines.push(`stale 응답 폐기 횟수: ${lifecycle.staleResponseDropCount}`);
    } else {
      lines.push("TrackLifecycleEngine을 찾을 수 없습니다.");
    }
    if (status?.lastBoundary) {
      const b = status.lastBoundary;
      const label = BOUNDARY_LABEL[b.type] || b.type;
      const details = [];
      if (b.reason) details.push(b.reason);
      if (b.score !== undefined) details.push(`score ${b.score.toFixed(2)}`);
      if (b.identityCues !== undefined) details.push(`identity ${b.identityCues}`);
      lines.push(`이번 틱 판정: ${label}${details.length ? ` (${details.join(" · ")})` : ""}`);
    }

    lines.push("");
    lines.push("── Deep Listen 녹화 진행 ──");
    if (status) {
      const seconds = status.audibleBufferSeconds;
      const target = status.audibleBufferCapSeconds;
      const isFull = seconds >= target - 0.05;
      lines.push(`오디오만 담은 버퍼: ${bar(seconds / target)} ${seconds.toFixed(1)}s / ${target}s${isFull ? " (가득 참 · 최신 30초로 계속 갱신 중)" : ""}`);
      const recordingState = status.uploadInFlight
        ? "전송 중 (Flamingo 서버로 업로드됨)"
        : status.currentlyAudible === null
          ? "대기 중 (오디오 세션 시작 전)"
          : status.currentlyAudible === false
            ? "동결됨 (무음 -- 버퍼는 그대로 보존, 채워지지 않음)"
            : isFull
              ? "대기 중 (버퍼는 이미 가득 -- 다음 30초 캡처 주기까지 최신 구간 유지)"
              : "채우는 중 (오디오 재생 중, 아직 30초 미만)";
      lines.push(`녹화 상태: ${recordingState}`);
      lines.push(`다음 캡처까지 남은 청취시간: ${(status.msUntilNextCapture / 1000).toFixed(1)}초`);
      lines.push(`캡처 요청 순번: ${status.requestSequence} · 마지막 캡처: ${status.lastTriggeredAtMs ? new Date(status.lastTriggeredAtMs).toLocaleTimeString("ko-KR") : "--"}`);
      const soundCloud = typeof getSoundCloudPlaybackState === "function" ? getSoundCloudPlaybackState() : null;
      const capture = typeof getAudioCaptureDebugState === "function" ? getAudioCaptureDebugState() : null;
      if (soundCloud) {
        lines.push(`SoundCloud: ${soundCloud.transport} · 연결 ${soundCloud.connected ? "완료" : "끊김"} · 단계 ${soundCloud.attachStage || "--"}`);
        lines.push(`PCM: rms ${(capture?.rms || 0).toFixed(4)} · peak ${(capture?.peak || 0).toFixed(4)} · ${soundCloud.audioFlowConfirmed ? "실제 신호 확인" : "신호 대기"}`);
        if (soundCloud.attachError) lines.push(`연결 오류: ${soundCloud.attachError}`);
      }
    } else {
      lines.push("Deep Listen 상태를 찾을 수 없습니다.");
    }

    lines.push("");
    lines.push("버퍼는 '최신 30초'를 계속 유지하는 롤링 창입니다 -- 가득 찬 뒤에도 계속 갱신됩니다.");
    lines.push("첫인상은 약 12초에 전송되고, 이후 정밀 캡처는 45초의 실제 청취 간격으로 예약됩니다.");
    lines.push("(Music Flamingo의 오디오 인코더는 30초가 상한이므로 더 긴 클립의 나머지는 사용되지 않습니다.");
    lines.push(" 각 캡처는 이전 해석문을 받지 않는 독립적인 blind listen이며, 같은 곡에 대한 누적 판단과");
    lines.push(" 강화·약화는 브라우저의 증거 저장소가 담당합니다.)");
    lines.push("정지가 아니라 일시정지라면 버퍼가 초기화되지 않고, 재생이 재개되면 같은 버퍼가 계속 채워집니다.");
    lines.push("곡이 실제로 바뀌면(음향 불연속) 또는 무음이 길게 이어지면 버퍼와 트랙 기억이 함께 초기화됩니다.");

    panel.querySelector(".trackStatusInspectorBody").textContent = lines.join("\n");
  }

  function renderFlamingoPool() {
    const reservoir = typeof getFlamingoWordReservoir === "function" ? getFlamingoWordReservoir() : null;
    const concepts = reservoir?.conceptRegistry?.size ? [...reservoir.conceptRegistry.values()] : [];
    const lines = ["── 🦩 Flamingo 단어 풀 (현재 트랙) ──"];
    if (!concepts.length) {
      lines.push("아직 Flamingo가 만든 개념이 없습니다.");
      const ingestion = typeof getSemanticState === "function" ? getSemanticState()?.flamingoIngestion : null;
      if (ingestion) {
        lines.push(`마지막 유입: ${ingestion.accepted ? "수락" : "거절"} · 구조화 ${ingestion.structuredConceptCount}개 · 관측 ${ingestion.receivedObservationCount}개`);
        lines.push(`저장소 ${ingestion.reservoirConceptCount}개 · trackEpoch ${ingestion.trackEpoch}${ingestion.usedObservationFallback ? " · 관측 복원 경로 사용" : ""}`);
      }
    } else {
      const inspect = typeof reservoir.inspect === "function" ? reservoir.inspect() : {};
      lines.push(`trackEpoch ${reservoir.trackEpoch} · 캡처 ${reservoir.packetCount}회 · 개념 ${inspect.canonicalConceptCount ?? concepts.length} · 클러스터 ${inspect.semanticClusterCount ?? "--"} · 표면 ${inspect.surfacePhraseCount ?? "--"}`);
      lines.push("");
      for (const entry of concepts.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
        const variants = (entry.family && entry.family.length ? entry.family : [entry.canonicalText]).join(" / ");
        const held = typeof reservoir.isPromotionEligible === "function" && !reservoir.isPromotionEligible(entry)
          ? ` · 보류(${typeof reservoir.promotionHoldReason === "function"
            ? reservoir.promotionHoldReason(entry) : "검증 대기"})` : "";
        lines.push(`[${entry.category}/${entry.layer}] "${entry.canonicalText}" 확신 ${(entry.confidence || 0).toFixed(2)} · 사용 ${entry.usageCount || 0}회${held}`);
        lines.push(`  → ${variants}`);
      }
    }
    panel.querySelector(".trackStatusInspectorFlamingo").textContent = lines.join("\n");
  }

  function renderResetBanner() {
    const banner = panel.querySelector(".trackStatusInspectorBanner");
    const lastReset = typeof getLastFlamingoReset === "function" ? getLastFlamingoReset() : null;
    if (!lastReset) { banner.hidden = true; return; }
    const age = Date.now() - lastReset.at;
    if (age < 0 || age > RESET_FLASH_MS) { banner.hidden = true; return; }
    // A genuinely NEW reset (different timestamp than the last one already shown) restarts the
    // flash window even if the panel was already open -- this is what makes the disappearance
    // visible as an EVENT rather than a static line that happens to say "0 concepts".
    lastAnnouncedResetAt = lastReset.at;
    const reasonLabel = RESET_REASON_LABEL[lastReset.reason] || lastReset.reason;
    const sample = lastReset.sampleTexts?.length ? ` (예: ${lastReset.sampleTexts.join(", ")})` : "";
    banner.hidden = false;
    banner.textContent = `🔄 방금 초기화됨 -- ${reasonLabel} · Flamingo 개념 ${lastReset.clearedCount}개 제거됨${sample}`;
    // Fades out over the flash window so "disappearing" is visibly animated, not a hard cut.
    banner.style.opacity = String(Math.max(0, 1 - age / RESET_FLASH_MS));
  }

  function render() {
    if (!panel || panel.hidden) return;
    renderStatus();
    renderFlamingoPool();
    renderResetBanner();
  }

  function toggle() {
    if (!panel) { createPanel(); panel.hidden = true; }
    panel.hidden = !panel.hidden;
    if (panel.hidden) { clearInterval(timer); timer = null; return; }
    render();
    panel.focus();
    timer = setInterval(render, 400);
  }

  return { toggle };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TrackStatusInspector;
