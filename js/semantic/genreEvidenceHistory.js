// Track-scoped histories for local classifier patches and blind Flamingo hearings.
// Generation memory never lives here: each record is evidence, with independence provenance.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenreEvidenceHistory = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const listeningModeOf = value => {
    const mode = String(value || "").toLowerCase();
    if (mode === "assisted") return "assisted";
    if (mode === "blind" || mode === "independent") return "blind";
    return "blind";
  };

  class History {
    constructor(options = {}) {
      this.max = Math.max(4, Number(options.max) || 24);
      this.reset();
    }

    reset() {
      this.local = [];
      this.flamingo = [];
      this.signatures = [];
      this.uncertainties = [];
      this.adjudications = [];
      this.sectionId = 0;
    }

    noteSectionChange() {
      this.sectionId += 1;
      return this.sectionId;
    }

    recordLocalPatch(patch = {}, at = Date.now()) {
      const topK = Array.isArray(patch.topK) ? patch.topK.slice(0, 5).map(item => ({
        label: String(item?.label || "").trim().slice(0, 64),
        score: clamp(item?.score ?? item?.confidence)
      })).filter(item => item.label) : [];
      if (!topK.length) return null;
      const record = {
        at,
        sectionId: patch.sectionId ?? this.sectionId,
        topK,
        rawTopScore: clamp(patch.rawTopScore ?? topK[0]?.score),
        runnerUpScore: clamp(patch.runnerUpScore ?? topK[1]?.score),
        margin: clamp(patch.margin),
        entropy: clamp(patch.entropy ?? 1),
        embedding: Array.isArray(patch.embedding) ? patch.embedding.slice(0, 32) : null
      };
      this.local.push(record);
      if (this.local.length > this.max) this.local.shift();
      return record;
    }

    recordFlamingo(entry = {}, at = Date.now()) {
      const listeningMode = listeningModeOf(entry.listeningMode || (entry.independent === false ? "assisted" : "blind"));
      const independent = listeningMode === "blind" && entry.independent !== false && !entry.conditionedOnClassifier;
      const hypotheses = (Array.isArray(entry.hypotheses) ? entry.hypotheses : [])
        .map(item => ({
          label: String(item?.label || item?.text || "").trim().slice(0, 64),
          confidence: clamp(item?.confidence),
          supportRefs: Array.isArray(item?.supportRefs) ? item.supportRefs.slice(0, 8) : [],
          provisional: Boolean(item?.provisional || entry.provisional)
        }))
        .filter(item => item.label);
      const record = {
        at,
        segmentId: entry.segmentId || entry.audioSegmentId || null,
        observationId: entry.observationId || null,
        listeningMode,
        independent,
        provisional: Boolean(entry.provisional),
        hypotheses,
        signatureCount: Array.isArray(entry.signatureRelations) ? entry.signatureRelations.length : 0
      };
      this.flamingo.push(record);
      if (this.flamingo.length > this.max) this.flamingo.shift();
      if (Array.isArray(entry.signatureRelations)) {
        for (const relation of entry.signatureRelations.slice(0, 4)) {
          const text = String(relation?.text || "").trim();
          if (!text) continue;
          this.signatures.push({
            at, text, id: relation.id || null,
            supportRefs: Array.isArray(relation.supportRefs) ? relation.supportRefs.slice(0, 8) : [],
            independent, segmentId: record.segmentId
          });
        }
        if (this.signatures.length > this.max) this.signatures.splice(0, this.signatures.length - this.max);
      }
      if (Array.isArray(entry.uncertainties)) {
        for (const item of entry.uncertainties.slice(0, 8)) {
          const text = String(item || "").trim();
          if (text) this.uncertainties.push({ at, text, independent, segmentId: record.segmentId });
        }
        if (this.uncertainties.length > this.max) this.uncertainties.splice(0, this.uncertainties.length - this.max);
      }
      return record;
    }

    recordAdjudication(entry = {}, at = Date.now()) {
      const record = {
        at,
        labels: (Array.isArray(entry.composite) ? entry.composite : []).map(item => ({
          label: String(item?.label || "").trim().slice(0, 64),
          confidence: clamp(item?.confidence),
          relation: item?.relation || null,
          synthesized: Boolean(item?.synthesized),
          independent: false,
          evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.slice(0, 8) : []
        })).filter(item => item.label),
        uncertainties: (Array.isArray(entry.uncertainties) ? entry.uncertainties : [])
          .map(item => String(item || "").trim()).filter(Boolean).slice(0, 5)
      };
      this.adjudications.push(record);
      if (this.adjudications.length > 8) this.adjudications.shift();
      return record;
    }

    independentFlamingoCount(label) {
      const key = String(label || "").toLowerCase().replace(/[\s_&-]+/g, "");
      if (!key) return 0;
      return this.flamingo.filter(record => record.independent &&
        record.hypotheses.some(item => item.label.toLowerCase().replace(/[\s_&-]+/g, "") === key)).length;
    }

    snapshot() {
      const localAgreement = (() => {
        if (this.local.length < 2) return this.local.length ? 1 : 0;
        const primary = this.local.map(item => item.topK[0]?.label).filter(Boolean);
        const mode = primary.sort()[Math.floor(primary.length / 2)];
        return primary.filter(label => label === mode).length / primary.length;
      })();
      const conflictingSections = (() => {
        const bySection = new Map();
        for (const item of this.local) {
          const label = item.topK[0]?.label;
          if (!label) continue;
          const set = bySection.get(item.sectionId) || new Set();
          set.add(label);
          bySection.set(item.sectionId, set);
        }
        const primaries = [...bySection.values()].map(set => [...set][0]);
        return new Set(primaries).size > 1 ? new Set(primaries).size - 1 : 0;
      })();
      return {
        localGenreHistory: this.local.slice(),
        blindFlamingoGenreHistory: this.flamingo.filter(item => item.independent).slice(),
        flamingoGenreHistory: this.flamingo.slice(),
        signatureRelationHistory: this.signatures.slice(),
        uncertaintyHistory: this.uncertainties.slice(),
        adjudications: this.adjudications.slice(),
        independentPatchCount: this.local.length,
        sectionAgreement: localAgreement,
        conflictingSectionCount: conflictingSections,
        independentFlamingoHearings: this.flamingo.filter(item => item.independent).length,
        assistedFlamingoHearings: this.flamingo.filter(item => !item.independent).length
      };
    }
  }

  return { History, listeningModeOf };
});
