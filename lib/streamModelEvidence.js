"use strict";
const Temporal = require("../js/ml/temporalAggregator");
const Classifier = require("../js/ml/genreClassifier");
const Calibration = require("../js/ml/confidenceCalibrator");
const { GenreTracker } = require("../js/ml/genreTracker");
const Instruments = require("../js/semantic/instrumentationEventEngine");
const { thresholds } = require("../js/ml/instrumentClassifier");
const { History } = require("../js/semantic/genreEvidenceHistory");

class StreamModelEvidence {
  constructor() {
    this.temporal = new Temporal.Aggregator();
    this.tracker = new GenreTracker();
    this.instruments = new Instruments.Engine();
    this.history = new History();
    this.observation = 0;
  }
  apply(result, state, at) {
    const aggregate = this.temporal.add(result, at);
    const canonical = label => String(label).split("---").at(-1).trim();
    const families = new Map(result.labels.genre.map(label => [canonical(label).toLowerCase(), label.split("---")[0]]));
    const familyFor = label => families.get(String(label).toLowerCase()) || "Unknown";
    const rank = values => Classifier.classify(values, result.labels.genre,
      { topK: 5, activation: result.activations.genre }).map(item => ({ ...item, label: canonical(item.label) }));
    const predictions = rank(aggregate.genre), rawPredictions = rank(result.genre);
    const tracked = this.tracker.update(predictions, { familyFor });
    const calibrated = Calibration.calibrate({ predictions, stability: tracked.stability,
      temporalAgreement: aggregate.diagnostics.genreAgreement, familyFor });
    const support = (predictions.find(item => item.label === tracked.primary)?.confidence || 0) /
      Math.max(0.0001, predictions[0]?.confidence || 0);
    const confidence = calibrated.semanticConfidence * Math.min(1, support);
    state.classifierGenre = { ...tracked, ...calibrated, confidence, semanticConfidence: confidence,
      uncertain: confidence < 0.34 || calibrated.unknown, source: "genre-classifier", sourceModel: result.model,
      classifierRawTopK: predictions, observations: aggregate.diagnostics.observations };
    state.genre = { ...state.classifierGenre };
    this.history.recordLocalPatch({ topK: rawPredictions,
      rawTopScore: rawPredictions[0]?.confidence, runnerUpScore: rawPredictions[1]?.confidence,
      margin: Math.max(0, (rawPredictions[0]?.confidence || 0) - (rawPredictions[1]?.confidence || 0)),
      entropy: Calibration.normalizedEntropy(rawPredictions), embedding: result.embedding,
      sectionId: aggregate.diagnostics.sectionCount }, at);
    state.genreEvidence = this.history.snapshot();
    const observationId = ++this.observation;
    const classifyInstruments = values => Classifier.classify(values, result.labels.instrument,
      { topK: result.labels.instrument.length, activation: result.activations.instrument })
      .filter(item => item.confidence >= (thresholds[item.label.toLowerCase()] ?? 0.2)).slice(0, 6)
      .map(item => ({ ...item, rawConfidence: item.confidence, source: "ml", sourceModel: result.model,
        observedAt: Date.now(), observationId }));
    state.instruments = classifyInstruments(aggregate.scales.fast.instrument);
    Object.assign(state, this.instruments.update(state.instruments,
      { ...state.expressionFeatures, eventInstruments: classifyInstruments(result.instrument), observationId }, Date.now()));
    state.ml = { lastUpdated: Date.now(), model: result.model, status: "ready", observations: observationId };
  }
}

module.exports = { StreamModelEvidence };
