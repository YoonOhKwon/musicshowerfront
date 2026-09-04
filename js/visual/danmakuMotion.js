const DanmakuMotion = (() => {
  function advance(x, direction, speed, deltaMilliseconds) {
    const seconds = Math.min(0.05, Math.max(0, Number(deltaMilliseconds) || 0) / 1000);
    return x + Math.sign(direction || 1) * Math.max(0, Number(speed) || 0) * seconds;
  }

  function progress(x, direction, viewportWidth, halfWidth) {
    const travel = Math.max(1, viewportWidth + halfWidth * 2);
    return direction < 0
      ? (viewportWidth + halfWidth - x) / travel
      : (x + halfWidth) / travel;
  }

  return { advance, progress };
})();

if (typeof module !== "undefined" && module.exports) module.exports = DanmakuMotion;
