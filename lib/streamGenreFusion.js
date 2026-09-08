"use strict";
const OpenWorld = require("../js/semantic/openWorldConceptRegistry");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");

// Reuse the existing evidence fusion after blind listening. Classifier predictions
// are never added to Flamingo's prompt, nor counted again as a second audio vote.
class StreamGenreFusion {
  constructor() {
    this.registry = new OpenWorld.Registry();
    this.engine = new GenreHypotheses.Engine({}, {});
  }
  ingest(observations) {
    for (const item of observations) {
      if (item.category !== "genre") continue;
      this.registry.propose({ label: item.text, conceptType: "genre",
        source: item.source, sourceFamily: item.sourceFamily, sourceModel: item.sourceModel,
        observationId: item.observationId, independenceGroup: item.independenceGroup,
        audioSegmentId: item.audioSegmentId, confidence: item.confidence,
        supportingEvidence: item.anchors, reasoningHints: item.reasoningHints,
        conditionedOnClassifier: item.conditionedOnClassifier,
        conditioningSources: item.conditioningSources,
        conditioningCandidateLabels: item.conditioningCandidateLabels });
    }
  }
  apply(state) {
    state.openWorldConcepts = this.registry.all({ compact: true });
    if (!state.classifierGenre && !state.openWorldConcepts.length) return;
    const reasoning = this.engine.evaluate({ ...state,
      classifierGenre: state.classifierGenre || { topK: [] } }, Date.now());
    state.genreReasoning = reasoning;
    if (!reasoning.primary) return;
    const confidence = reasoning.primary.semanticConfidence || 0;
    state.genre = { ...state.classifierGenre, primary: reasoning.primary.genre,
      confidence, semanticConfidence: confidence, uncertain: confidence < 0.34,
      topK: reasoning.hypotheses.slice(0, 5).map(item => ({ label: item.genre,
        confidence: item.semanticConfidence, semanticConfidence: item.semanticConfidence,
        kind: item.kind, evidenceCoverage: item.evidenceCoverage })),
      secondary: reasoning.challengers.slice(0, 4).map(item => ({ label: item.genre,
        confidence: item.semanticConfidence, evidenceCoverage: item.evidenceCoverage })),
      alternativeHypotheses: reasoning.alternatives, related: reasoning.relatedGenres,
      fineCandidates: reasoning.actualSubgenres };
  }
}
module.exports = { StreamGenreFusion };
