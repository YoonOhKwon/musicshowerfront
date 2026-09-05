let smoothBass = 0;
let smoothMid = 0;
let smoothHigh = 0;
let smoothEnergy = 0;
let previousBassEnergy = 0;
let previousMidEnergy = 0;
let previousHighEnergy = 0;
let previousEnergy = 0;
let lastBeatTime = 0;
let beatFlash = 0;
let beatScale = 0;
let bpm = 0;
let bpmConfidence = 0;
const bpmHistory = new RingBuffer(CONFIG.beat.historySize);
const beatIntervalHistory = new RingBuffer(CONFIG.beat.historySize);
const beatTimestamps = new RingBuffer(128);
const onsetEvents = new RingBuffer(128);
const onsetMetricHistory = new RingBuffer(120);

const smoothValue = (current, target, amount) => current + (target - current) * amount;

function resetBeatDetection() {
  smoothBass = 0;
  smoothMid = 0;
  smoothHigh = 0;
  smoothEnergy = 0;
  previousBassEnergy = 0;
  previousMidEnergy = 0;
  previousHighEnergy = 0;
  previousEnergy = 0;
  lastBeatTime = 0;
  beatFlash = 0;
  beatScale = 0;
  bpm = 0;
  bpmConfidence = 0;
  bpmHistory.clear();
  beatIntervalHistory.clear();
  beatTimestamps.clear();
  onsetEvents.clear();
  onsetMetricHistory.clear();
}

function updateBeatDetection() {
  if (!audioFrequencyData || !realtimeAudioFeatures) return false;

  const bands = realtimeAudioFeatures.bands;
  const bassEnergy = (bands.subBass * 0.45 + bands.bass * 0.55);
  const midEnergy = (bands.lowMid * 0.35 + bands.mid * 0.65);
  const highEnergy = (bands.highMid * 0.5 + bands.brilliance * 0.35 + bands.air * 0.15);
  const energy = realtimeAudioFeatures.energy;
  const flux = realtimeAudioFeatures.spectralFlux;

  smoothBass = smoothValue(smoothBass, bassEnergy * 255, 0.2);
  smoothMid = smoothValue(smoothMid, midEnergy * 255, 0.16);
  smoothHigh = smoothValue(smoothHigh, highEnergy * 255, 0.16);
  smoothEnergy = smoothValue(smoothEnergy, energy, 0.15);

  const baseline = SignalMath.robustStats(onsetMetricHistory.values());
  const threshold = Math.max(
    CONFIG.beat.minFlux,
    baseline.mean + baseline.std * CONFIG.beat.fluxThresholdStd
  );
  const bassRise = bassEnergy - previousBassEnergy;
  const midRise = midEnergy - previousMidEnergy;
  const highRise = highEnergy - previousHighEnergy;
  const energyRise = energy - previousEnergy;
  const now = performance.now();
  const strongTransient = flux > threshold * 1.45;
  const supportedTransient = bassRise > CONFIG.beat.bassRise || energyRise > 0.003;

  const detected =
    now - lastBeatTime > CONFIG.beat.cooldown &&
    energy > CONFIG.beat.minEnergy &&
    flux > threshold &&
    (supportedTransient || strongTransient);

  if (detected) {
    if (lastBeatTime > 0) updateBPMFromInterval(now - lastBeatTime);
    lastBeatTime = now;
    beatTimestamps.push(now);
    const positiveRises = [bassRise, midRise, highRise].map(value => Math.max(0, value));
    const riseTotal = positiveRises.reduce((sum, value) => sum + value, 0);
    const impact = (rise, floor, share) => SignalMath.clamp(
      SignalMath.clamp(Math.max(0, rise) / Math.max(0.0001, floor * 2)) * 0.68 + share * 0.32
    );
    const lowImpact = impact(bassRise, CONFIG.beat.bassRise, riseTotal ? positiveRises[0] / riseTotal : 0);
    const midImpact = impact(midRise, CONFIG.beat.midRise, riseTotal ? positiveRises[1] / riseTotal : 0);
    const highImpact = impact(highRise, CONFIG.beat.highRise, riseTotal ? positiveRises[2] / riseTotal : 0);
    const ordered = [{ band: "low", value: lowImpact }, { band: "mid", value: midImpact },
      { band: "high", value: highImpact }].sort((a, b) => b.value - a.value);
    const onsetClass = ordered[0].value >= 0.5 && ordered[0].value - ordered[1].value >= 0.08
      ? ({ low: "kick", mid: "backbeat", high: "hat" })[ordered[0].band] : "mixed";
    onsetEvents.push({ at: now, strength: SignalMath.clamp(flux / Math.max(0.001, threshold * 1.5)),
      // Band-local TRANSIENT rises, not steady absolute band energy. A sustained bright or
      // mid-heavy passage therefore cannot turn every unrelated onset into a hat/backbeat.
      lowImpact, midImpact, highImpact, onsetClass,
      spectralContrast: SignalMath.clamp(ordered[0].value - ordered[1].value) });
    beatFlash = 1;
    beatScale = 1;
  }

  pushOnsetMetric(flux);
  previousBassEnergy = bassEnergy;
  previousMidEnergy = midEnergy;
  previousHighEnergy = highEnergy;
  previousEnergy = energy;
  beatFlash *= 0.9;
  beatScale *= 0.89;
  return detected;
}

function pushOnsetMetric(value) {
  onsetMetricHistory.push(Number(value) || 0);
}

function updateBPMFromInterval(interval) {
  if (interval < 180 || interval > 2200) return;
  const raw = 60000 / interval;
  if (raw < 30 || raw > 340) return;

  const candidate = SignalMath.foldBpm(raw, CONFIG.beat.bpmFoldMin, CONFIG.beat.bpmFoldMax);
  if (candidate < CONFIG.beat.bpmMin || candidate > CONFIG.beat.bpmMax) return;

  bpmHistory.push(candidate);
  const bpmValues = bpmHistory.values();
  const center = SignalMath.median(bpmValues);
  const inliers = bpmValues.filter(value => Math.abs(value - center) <= Math.max(5, center * 0.12));
  bpm = SignalMath.median(inliers.length >= 3 ? inliers : bpmValues);

  beatIntervalHistory.push(60000 / candidate);

  const spread = SignalMath.std(inliers.length ? inliers : bpmValues);
  const consistency = center ? SignalMath.clamp(1 - spread / (center * 0.12)) : 0;
  const evidence = SignalMath.clamp(bpmHistory.length / 10);
  bpmConfidence = consistency * evidence;
}

function getRhythmProfile() {
  const intervals = SignalMath.robustStats(beatIntervalHistory.values());
  const currentTime = performance.now();
  const recentBeats = beatTimestamps.values().filter(timestamp => currentTime - timestamp <= 15000);
  return {
    bpm: bpm || 0,
    confidence: currentTime - lastBeatTime < 3000 ? bpmConfidence : 0,
    stability: currentTime - lastBeatTime < 3000 ? bpmConfidence : 0,
    beatIntervalMean: intervals.mean,
    beatIntervalStd: intervals.std,
    beatCount: beatIntervalHistory.length,
    onsetRate: recentBeats.length / 15,
    currentFlux: realtimeAudioFeatures.spectralFlux,
    adaptiveThreshold: Math.max(
      CONFIG.beat.minFlux,
      SignalMath.mean(onsetMetricHistory.values()) + SignalMath.std(onsetMetricHistory.values()) * CONFIG.beat.fluxThresholdStd
    )
  };
}
