const SignalMath = (() => {
  const clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, Number(value) || 0));

  const mean = values => {
    if (!values?.length) return 0;
    return values.reduce((sum, value) => sum + (Number(value) || 0), 0) / values.length;
  };

  const variance = values => {
    if (!values?.length) return 0;
    const center = mean(values);
    return mean(values.map(value => Math.pow((Number(value) || 0) - center, 2)));
  };

  const std = values => Math.sqrt(variance(values));

  const median = values => {
    if (!values?.length) return 0;
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  const percentile = (values, ratio) => {
    if (!values?.length) return 0;
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const index = clamp(ratio) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  const robustStats = values => {
    const clean = (values || []).map(Number).filter(Number.isFinite);
    if (!clean.length) {
      return { mean: 0, std: 0, min: 0, max: 0, range: 0, median: 0, p10: 0, p90: 0 };
    }
    const sorted = clean.slice().sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const quantile = ratio => {
      const index = clamp(ratio) * (sorted.length - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    };
    return {
      mean: mean(clean),
      std: std(clean),
      min,
      max,
      range: max - min,
      median: quantile(0.5),
      p10: quantile(0.1),
      p90: quantile(0.9)
    };
  };

  const createBandPlan = (sampleRate, fftSize, definitions, binCount = Math.floor(fftSize / 2)) => {
    if (!sampleRate || !fftSize) return [];
    const hzPerBin = sampleRate / fftSize;
    const nyquist = sampleRate / 2;
    return Object.entries(definitions || {}).map(([name, [low, high]]) => ({
      name,
      start: Math.max(0, Math.ceil(low / hzPerBin)),
      end: Math.min(binCount, Math.ceil(Math.min(high, nyquist) / hzPerBin))
    }));
  };

  const averageBandsWithPlan = (frequencyData, plan) => {
    const result = Object.fromEntries((plan || []).map(range => [range.name, 0]));
    if (!frequencyData?.length) return result;
    for (const range of plan || []) {
      let sum = 0;
      const end = Math.min(range.end, frequencyData.length);
      for (let index = range.start; index < end; index++) sum += frequencyData[index] / 255;
      result[range.name] = end > range.start ? sum / (end - range.start) : 0;
    }
    return result;
  };

  const averageBands = (frequencyData, sampleRate, fftSize, definitions) => {
    if (!frequencyData?.length || !sampleRate || !fftSize) {
      return Object.fromEntries(Object.keys(definitions).map(name => [name, 0]));
    }
    return averageBandsWithPlan(
      frequencyData,
      createBandPlan(sampleRate, fftSize, definitions, frequencyData.length)
    );
  };

  const spectralFlux = (current, previous) => {
    if (!current?.length || !previous?.length) return 0;
    const length = Math.min(current.length, previous.length);
    let positiveChange = 0;
    for (let index = 0; index < length; index++) {
      positiveChange += Math.max(0, current[index] - previous[index]) / 255;
    }
    return positiveChange / length;
  };

  const spectralCentroid = (frequencyData, sampleRate, fftSize) => {
    if (!frequencyData?.length || !sampleRate || !fftSize) return 0;
    const hzPerBin = sampleRate / fftSize;
    let weighted = 0;
    let total = 0;
    for (let index = 0; index < frequencyData.length; index++) {
      const magnitude = frequencyData[index] / 255;
      weighted += index * hzPerBin * magnitude;
      total += magnitude;
    }
    return total ? weighted / total : 0;
  };

  const foldBpm = (bpm, min = 75, max = 175) => {
    let value = Number(bpm) || 0;
    if (value <= 0) return 0;
    while (value < min) value *= 2;
    while (value > max) value /= 2;
    return value;
  };

  const normalizedDistance = (left, right) => {
    if (!left?.length || !right?.length) return 1;
    const length = Math.min(left.length, right.length);
    let total = 0;
    for (let index = 0; index < length; index++) {
      total += Math.abs(clamp(left[index]) - clamp(right[index]));
    }
    return total / length;
  };

  const meanVectorDistance = history => {
    if (!history || history.length < 2) return 0;
    let total = 0;
    let pairs = 0;
    for (let frameIndex = 1; frameIndex < history.length; frameIndex++) {
      const previous = history[frameIndex - 1] || [];
      const current = history[frameIndex] || [];
      const length = Math.min(previous.length, current.length);
      if (!length) continue;
      let frameDistance = 0;
      for (let index = 0; index < length; index++) {
        frameDistance += Math.abs((Number(current[index]) || 0) - (Number(previous[index]) || 0));
      }
      total += frameDistance / length;
      pairs += 1;
    }
    return pairs ? total / pairs : 0;
  };

  const ratioAbove = (values, threshold) => {
    const clean = (values || []).map(Number).filter(Number.isFinite);
    if (!clean.length) return 0;
    return clean.filter(value => value > threshold).length / clean.length;
  };

  return {
    clamp,
    mean,
    variance,
    std,
    median,
    percentile,
    robustStats,
    createBandPlan,
    averageBandsWithPlan,
    averageBands,
    spectralFlux,
    spectralCentroid,
    foldBpm,
    normalizedDistance,
    meanVectorDistance,
    ratioAbove
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SignalMath;
}
