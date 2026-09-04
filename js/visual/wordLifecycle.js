const WordLifecycle = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  function alpha(progress, maximum = 255, fadeInFraction = 0.025) {
    return maximum * clamp(Number(progress) / Math.max(0.005, fadeInFraction));
  }
  function exited(x, direction, viewportWidth, halfWidth) {
    return direction < 0 ? x + halfWidth < 0 : x - halfWidth > viewportWidth;
  }
  function expectedTravelMs(viewportWidth, halfWidth, speed) {
    return (Math.max(1, viewportWidth) + Math.max(0, halfWidth) * 2) /
      Math.max(1, speed) * 1000;
  }
  function stalled(now, lastMovementAt, expectedMs) {
    return Number.isFinite(lastMovementAt) && now - lastMovementAt >
      Math.max(60000, expectedMs * 2);
  }
  function canSpawn(activeCount, maximum) {
    return Math.max(0, activeCount) < Math.max(1, maximum);
  }
  function densityFactor(activeCount, maximum) {
    const ratio = Math.max(0, activeCount) / Math.max(1, maximum);
    if (ratio >= 0.8) return 2;
    if (ratio >= 0.55) return 1.45;
    return 1;
  }
  return { alpha, exited, expectedTravelMs, stalled, canSpawn, densityFactor };
})();
if (typeof module !== "undefined" && module.exports) module.exports = WordLifecycle;
