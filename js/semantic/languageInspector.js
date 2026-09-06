const LanguageInspector = (() => {
  const STORAGE_KEY = "music-shower-language-feedback-v1";
  let panel = null;
  let timer = null;
  let signature = "";
  let feedback = [];

  // The two-tier epistemology's own grouping (엄격/중간/개방), not a new taxonomy: LIVE/FACT are
  // the strict layer, CONTEXT is the middle (conditional style hypotheses), AESTHETIC/IMPRESSION
  // are the open layer. Selection-rate collapse here is the whole point of Part C-2 -- once
  // vocabulary grows and candidates outnumber slots, this is the only place that shows whether the
  // selector is still picking sensibly or just taking whatever survived the critic in order.
  const LAYER_TIER = { LIVE: "strict", FACT: "strict", CONTEXT: "middle", AESTHETIC: "open", IMPRESSION: "open" };
  function layerTier(layer) { return LAYER_TIER[layer] || "unknown"; }
  function axisBucket(count) {
    const n = Number(count) || 0;
    return n <= 1 ? "1" : n === 2 ? "2" : "3+";
  }

  function isMusicFlamingo(candidate, semantic = null) {
    if (!candidate) return false;
    const diagnostics = candidate.diagnostics || {};
    const provSources = Array.isArray(candidate.provenance?.source)
      ? candidate.provenance.source
      : [candidate.provenance?.source].filter(Boolean);
    const sources = Array.isArray(candidate.source)
      ? candidate.source
      : [candidate.source].filter(Boolean);
    const fusionSources = Array.isArray(candidate.fusionSources)
      ? candidate.fusionSources
      : [candidate.fusionSources].filter(Boolean);
    const anchors = Array.isArray(candidate.anchors) ? candidate.anchors : [];
    const claimsUsed = Array.isArray(diagnostics.claimsUsed) ? diagnostics.claimsUsed : [];

    // Direct source / provider / model flags
    if (candidate.sourceModel === "music-flamingo" || candidate.provider === "music-flamingo") return true;
    if (diagnostics.provider === "music-flamingo" || diagnostics.sourceModel === "music-flamingo") return true;
    if (sources.some(s => s === "directAudio" || s === "music-flamingo")) return true;
    if (fusionSources.some(s => s === "directAudio" || s === "music-flamingo")) return true;
    if (provSources.some(s => s === "directAudio" || s === "music-flamingo")) return true;
    if (diagnostics.source === "directAudio" || diagnostics.source === "music-flamingo") return true;

    // Direct audio evidence anchors
    if (anchors.some(a => typeof a === "string" && (a.includes("directAudio") || a.includes("flamingo")))) return true;

    // Direct audio observation IDs
    if (typeof candidate.observationId === "string" && candidate.observationId.includes("flam")) return true;
    if (typeof diagnostics.observationId === "string" && diagnostics.observationId.includes("flam")) return true;

    // Claims derived from Flamingo caption
    if (claimsUsed.some(c => typeof c === "string" && (c.includes("audio-caption") || c.includes("flamingo")))) return true;

    // Open-world concept match originating from Flamingo
    const textNorm = String(candidate.text || "").trim().toLowerCase();
    if (textNorm && semantic?.openWorldConcepts) {
      const matchedConcept = semantic.openWorldConcepts.find(c => {
        const cLabel = String(c.canonicalLabel || "").trim().toLowerCase();
        return cLabel && (textNorm === cLabel || textNorm.includes(cLabel) || cLabel.includes(textNorm));
      });
      if (matchedConcept && (
        matchedConcept.sourceFamily === "directAudio" ||
        matchedConcept.sourceModel === "music-flamingo" ||
        (Array.isArray(matchedConcept.sources) && matchedConcept.sources.includes("directAudio"))
      )) {
        return true;
      }
    }

    // Active direct audio fusion match
    if (textNorm && semantic?.evidenceFusion) {
      const match = semantic.evidenceFusion.find(c => {
        const cText = String(c.text || "").trim().toLowerCase();
        return cText === textNorm && (
          c.source === "directAudio" ||
          (Array.isArray(c.fusionSources) && c.fusionSources.includes("directAudio")) ||
          (Array.isArray(c.anchors) && c.anchors.some(a => typeof a === "string" && a.includes("directAudio")))
        );
      });
      if (match) return true;
    }

    return false;
  }

  // Pure so it can be unit tested without a DOM: takes the same de-duplicated candidate list and
  // selected-text set render() already builds, returns the numbers C-2 asks the panel to expose.
  function selectionStatsOf(candidates = [], selectedTexts = new Set(), semantic = null) {
    const candidateCount = candidates.length;
    const selectedCount = candidates.filter(item => selectedTexts.has(item.text)).length;
    let flamingoCount = 0;
    let flamingoSelectedCount = 0;
    const byLayerTier = {};
    const byAxisBucket = {};
    for (const candidate of candidates) {
      if (isMusicFlamingo(candidate, semantic)) {
        flamingoCount += 1;
        if (selectedTexts.has(candidate.text)) flamingoSelectedCount += 1;
      }
      const tier = layerTier(candidate.layer);
      byLayerTier[tier] = byLayerTier[tier] || { total: 0, selected: 0 };
      byLayerTier[tier].total += 1;
      const bucket = axisBucket((candidate.diagnostics?.evidenceAxes || []).length);
      byAxisBucket[bucket] = byAxisBucket[bucket] || { total: 0, selected: 0 };
      byAxisBucket[bucket].total += 1;
      if (selectedTexts.has(candidate.text)) {
        byLayerTier[tier].selected += 1;
        byAxisBucket[bucket].selected += 1;
      }
    }
    const topDropped = candidates.filter(item => !selectedTexts.has(item.text))
      .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)
      .map(item => ({ text: item.text, score: item.score || 0, layer: item.layer,
        rejectionReason: item.valid === false ? (item.diagnostics?.rejectionReason || "?") : "not-selected" }));
    return {
      candidateCount, selectedCount, selectionRate: candidateCount ? selectedCount / candidateCount : 0,
      flamingoCount, flamingoSelectedCount,
      byLayerTier, byAxisBucket, topDropped
    };
  }

  function readFeedback() {
    try { feedback = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").slice(-200); }
    catch { feedback = []; }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function saveFeedback(candidate, vote, snapshot) {
    const existing = feedback.find(item => item.text === candidate.text && item.fingerprint === snapshot?.fingerprint);
    feedback = feedback.filter(item => !(item.text === candidate.text && item.fingerprint === snapshot?.fingerprint));
    if (existing?.vote !== vote) feedback.push({
      feedbackSchemaVersion: 2,
      voteMeaning: "manual-evaluation-only",
      text: candidate.text, vote, fingerprint: snapshot?.fingerprint || "", at: new Date().toISOString(),
      score: candidate.score, type: candidate.type, perspective: candidate.perspective,
      diagnostics: {
        primaryGenre: snapshot?.primaryGenre || null,
        semanticConfidence: snapshot?.semanticConfidence ?? snapshot?.confidence ?? null,
        temporalStability: snapshot?.temporalStability ?? null,
        evidenceCoverage: snapshot?.genreReasoning?.primary?.evidenceCoverage ?? null,
        challengers: snapshot?.genreReasoning?.challengers || [],
        takeovers: snapshot?.genreReasoning?.takeovers || [],
        liveEventCount: snapshot?.temporalState?.liveEvents?.length || 0,
        staleClaims: snapshot?.temporalState?.stale || [],
        contradictions: snapshot?.temporalState?.contradictions || [],
        suppressedClaims: snapshot?.temporalState?.suppressed || []
      },
      snapshot
    });
    feedback = feedback.slice(-200);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(feedback)); }
    catch { /* Evaluation storage must never affect playback. */ }
    signature = "";
    render();
  }

  function exportFeedback() {
    const blob = new Blob([JSON.stringify(feedback, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = "music-shower-language-feedback.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createPanel() {
    readFeedback();
    panel = element("section", undefined, "languageInspector");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "언어 생성 평가");
    panel.tabIndex = -1;
    const header = element("header");
    header.append(element("h2", "언어 생성 평가"));
    const exportButton = element("button", "평가 저장");
    exportButton.addEventListener("click", exportFeedback);
    const close = element("button", "닫기 · L");
    close.addEventListener("click", toggle);
    header.append(exportButton, close);
    const status = element("pre", "", "languageInspectorStatus");
    const tokenDetails = element("details");
    tokenDetails.open = true;
    tokenDetails.append(element("summary", "LLM 토큰 추적"), element("pre", "", "languageInspectorTokens"));
    const selectionDetails = element("details");
    selectionDetails.open = true;
    selectionDetails.append(element("summary", "선별 통계"), element("pre", "", "languageInspectorSelectionStats"));
    const details = element("details");
    details.append(element("summary", "전송한 의미 스냅샷"), element("pre", "", "languageInspectorSnapshot"));
    const note = element("p", undefined, "languageInspectorNote");
    note.append(
      element("span", "점수는 음악 관련성·현재 상태·명료성·자연스러움 기준입니다. 음압은 디지털 신호 세기이며 압축·분위기는 추정입니다. 👍/👎는 수동 평가 표식입니다. "),
      element("br")
    );
    const legend = element("span", undefined, "flamingoLegend");
    legend.append(
      element("span", "🦩 Flamingo", "flamingoBadge"),
      element("span", " 핫핑크 배지/색상 표시 단어: Music Flamingo (직접 음향 청취 모델) 유래")
    );
    note.append(legend);
    panel.append(header, status, tokenDetails, selectionDetails, details, note, element("div", undefined, "languageInspectorCandidates"));
    panel.addEventListener("keydown", event => { if (event.key === "Escape") toggle(); });
    document.body.append(panel);
  }

  function render() {
    if (!panel || panel.hidden) return;
    const inspection = getLanguageInspectionState();
    const state = inspection.state || {};
    const tokens = state.tokenUsage || {};
    const requestTokens = tokens.request || {};
    const projectTokens = tokens.projectSession || tokens.languageSession || {};
    const semantic = getSemanticState();
    const primaryHypothesis = semantic.genreReasoning?.primary;
    const temporal = semantic.temporalEvidence || {};
    const count = value => Math.max(0, Number(value) || 0).toLocaleString("ko-KR");
    const percent = value => `${Math.round(Math.max(0, Number(value) || 0) * 100)}%`;
    panel.querySelector(".languageInspectorStatus").textContent = [
      `Provider: ${state.provider || "--"} · ${state.model || "--"}`,
      `State: ${state.status || "idle"} · epoch ${semantic.semanticEpoch || 0} · fingerprint ${state.fingerprint || "--"}`,
      `Primary: ${primaryHypothesis?.genre || "--"} · semantic ${(primaryHypothesis?.semanticConfidence || 0).toFixed(2)} · stability ${(primaryHypothesis?.temporalStability || 0).toFixed(2)} · coverage ${(primaryHypothesis?.evidenceCoverage || 0).toFixed(2)}`,
      `Challengers: ${(semantic.genreReasoning?.challengers || []).slice(0, 4).map(item => `${item.genre} ${(Number(item.semanticConfidence) || 0).toFixed(2)}/${(Number(item.temporalStability) || 0).toFixed(2)}`).join(" · ") || "--"}`,
      `Temporal: LIVE ${(temporal.liveEvents || []).length} · short ${(temporal.shortTermStates || []).length} · traits ${(temporal.trackTraits || []).length} · stale ${(temporal.stale || []).length} · suppressed ${(temporal.suppressed || []).length} · contradictions ${(temporal.contradictions || []).length}`,
      `Facets: ${SemanticFacets.names.join(" / ")}`,
      `Candidates ${state.candidateCount || 0} → selected ${state.selectedCount || 0} · remaining ${state.remaining || 0}`,
      `Layer survival: ${JSON.stringify(state.survival?.layers || {})}`,
      `FACT sources: ${JSON.stringify(state.survival?.factSources || {})}`,
      `Context families: ${JSON.stringify(state.survival?.relationFamilies || {})}`,
      `Latency ${state.latencyMs || 0} ms · reason ${state.reason || "--"} · cache ${state.cache || "--"}`,
      `Last LLM tokens: input ${count(requestTokens.inputTokens)} (cached ${count(requestTokens.cachedInputTokens)}) · output ${count(requestTokens.outputTokens)} (reasoning ${count(requestTokens.reasoningTokens)}) · total ${count(requestTokens.totalTokens)}`,
      `Project tokens: calls ${count(projectTokens.requests)} · input ${count(projectTokens.inputTokens)} · output ${count(projectTokens.outputTokens)} · total ${count(projectTokens.totalTokens)} · input cache ${percent(projectTokens.cacheHitRate)}`,
      `Error: ${state.error || "none"}`
    ].join("\n");
    panel.querySelector(".languageInspectorTokens").textContent = JSON.stringify({
      lastRequest: requestTokens,
      languageSession: tokens.languageSession || {},
      projectSession: projectTokens,
      note: state.cache === "server" || state.cache === "hit"
        ? "캐시에서 재사용한 결과는 새 LLM 토큰으로 계산하지 않습니다." : "Responses API가 반환한 usage 기준입니다."
    }, null, 2);
    panel.querySelector(".languageInspectorSnapshot").textContent = JSON.stringify(inspection.snapshot, null, 2);
    const nextSignature = JSON.stringify([state.fingerprint, state.provider, inspection.selected?.map(item => item.text), feedback.length, feedback.at(-1)?.at]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    panel.querySelector(".languageInspectorSnapshot").textContent = JSON.stringify(inspection.snapshot, null, 2);
    const list = panel.querySelector(".languageInspectorCandidates");
    list.replaceChildren();
    const selected = new Set((inspection.selected || []).map(item => item.text));
    const unique = new Map();
    for (const candidate of inspection.candidates || []) {
      const previous = unique.get(candidate.text);
      if (previous) previous.duplicateCount += 1;
      else unique.set(candidate.text, { ...candidate, duplicateCount: 1 });
    }
    const candidates = [...unique.values()].sort((a, b) => Number(selected.has(b.text)) - Number(selected.has(a.text)) || b.score - a.score);
    const stats = selectionStatsOf(candidates, selected, semantic);
    const tierLine = tier => `${tier} ${stats.byLayerTier[tier]?.selected || 0}/${stats.byLayerTier[tier]?.total || 0}`;
    const axisLine = bucket => `${bucket}축 ${stats.byAxisBucket[bucket]?.selected || 0}/${stats.byAxisBucket[bucket]?.total || 0}` +
      ` (${stats.byAxisBucket[bucket]?.total ? Math.round(stats.byAxisBucket[bucket].selected / stats.byAxisBucket[bucket].total * 100) : 0}%)`;
    panel.querySelector(".languageInspectorSelectionStats").textContent = [
      `Candidates ${stats.candidateCount} → selected ${stats.selectedCount} · rate ${Math.round(stats.selectionRate * 100)}%`,
      `🦩 Music Flamingo: ${stats.flamingoCount}개 후보 (선택 ${stats.flamingoSelectedCount}개)`,
      `By tier (엄격/중간/개방): ${["strict", "middle", "open"].map(tierLine).join(" · ")}`,
      `By axis count (3+ 조합 생존율이 향후 과다생성 튜닝의 핵심 지표): ${["1", "2", "3+"].map(axisLine).join(" · ")}`,
      `Top dropped: ${stats.topDropped.map(item => `${item.text}(${item.score.toFixed(2)}/${item.layer}/${item.rejectionReason})`).join(" · ") || "--"}`
    ].join("\n");
    for (const candidate of candidates) {
      const row = element("article", undefined, "languageInspectorCandidate");
      row.dataset.selected = String(selected.has(candidate.text));
      const isFlamingo = isMusicFlamingo(candidate, semantic);
      if (isFlamingo) {
        row.dataset.flamingo = "true";
      }
      const description = element("div");
      const diagnostics = candidate.diagnostics || {};
      // Why a phrase is on screen — or why it is not — must be readable without opening a tooltip:
      // layer/distance, the quality scores that decided it, and the specific rejection cause.
      const stage = selected.has(candidate.text) ? "선택"
        : candidate.valid === false ? `탈락(${diagnostics.rejectionReason || "?"})` : "후보";
      const contradiction = diagnostics.contradiction > 0 ? ` · 모순 ${diagnostics.contradiction.toFixed(2)}` : "";
      const axes = (diagnostics.evidenceAxes || []).length;
      const gateSummary = Object.entries(diagnostics.gates || {}).map(([key, pass]) => `${key}:${pass ? "✓" : "✗"}`).join(" ");
      const titleStrong = element("strong", candidate.text);
      if (isFlamingo) {
        titleStrong.append(element("span", "🦩 Flamingo", "flamingoBadge"));
      }
      const flamingoBadgeText = isFlamingo ? " · [🦩 Music Flamingo]" : "";
      description.append(titleStrong, element("small",
        `${stage} · ${candidate.layer || "?"}/d${candidate.semanticDistance ?? "?"} · ${candidate.perspective}` +
        flamingoBadgeText +
        ` · 확신 ${Math.round((candidate.confidence || 0) * 100)}% · 근거 ${(candidate.evidenceScore || 0).toFixed(2)}/${(diagnostics.evidenceThreshold || 0).toFixed(2)}` +
        ` · 축 ${axes} · 특이 ${(candidate.specificity || 0).toFixed(2)} · 신선 ${(candidate.novelty || 0).toFixed(2)}` +
        ` · 대비 ${(diagnostics.contrastiveness || 0).toFixed(2)} · 점수 ${(candidate.score || 0).toFixed(2)}` +
        ` · ${candidate.source || diagnostics.source || "local"} · ${candidate.relationFamily || "NONE"}` +
        `${diagnostics.genome ? ` · ${diagnostics.genome}` : ""}${diagnostics.operator ? ` · ${diagnostics.operator}` : ""}` +
        `${(diagnostics.claimsUsed || []).length ? ` · claims ${(diagnostics.claimsUsed || []).join("+")}` : ""}` +
        `${diagnostics.primitive ? " · 원시" : ""}${contradiction}` +
        `${gateSummary ? ` · ${gateSummary}` : ""}` +
        `${candidate.duplicateCount > 1 ? ` · 원본 중복 ${candidate.duplicateCount}개` : ""}`));
      description.title = JSON.stringify({ anchors: candidate.anchors, isFlamingo, ...candidate.diagnostics }, null, 2);
      row.append(description);
      for (const [vote, label] of [["keep", "👍"], ["reject", "👎"]]) {
        const button = element("button", label);
        button.setAttribute("aria-label", `${candidate.text} ${vote === "keep" ? "유지" : "제외"}`);
        const previous = feedback.find(item => item.text === candidate.text && item.fingerprint === inspection.snapshot?.fingerprint);
        button.setAttribute("aria-pressed", String(previous?.vote === vote));
        button.addEventListener("click", () => saveFeedback(candidate, vote, inspection.snapshot));
        row.append(button);
      }
      list.append(row);
    }
  }

  function toggle() {
    if (!panel) { createPanel(); panel.hidden = true; }
    panel.hidden = !panel.hidden;
    if (panel.hidden) { clearInterval(timer); timer = null; return; }
    signature = "";
    render();
    panel.focus();
    timer = setInterval(render, 1500);
  }
  return { toggle, layerTier, axisBucket, selectionStatsOf, isMusicFlamingo };
})();
if (typeof module !== "undefined" && module.exports) module.exports = LanguageInspector;
