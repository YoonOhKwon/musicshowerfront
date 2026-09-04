let wordLaneCursor = 0;
let wordDirectionCursor = 0;

function getNextWordLane(activeWords = [], direction = 1) {
  const top = Math.max(90, height * 0.16);
  const bottom = Math.min(height - 70, height * 0.84);
  const usableHeight = Math.max(CONFIG.visual.wordLaneHeight, bottom - top);
  const laneCount = Math.max(1, Math.floor(usableHeight / CONFIG.visual.wordLaneHeight));
  const lanes = Array.from({ length: laneCount }, (_, index) =>
    top + ((index + 0.5) / laneCount) * usableHeight);
  const start = wordLaneCursor++ % laneCount;
  const score = (lane, offset) => activeWords.reduce((total, word) => {
    if (word.life <= 0 || Math.abs(word.y - lane) > CONFIG.visual.wordLaneHeight * 0.46) return total;
    // Words near the same entry edge are the strongest collision risk.
    const entryRisk = word.direction === direction && word.progress < 0.42 ? 3 : 1;
    return total + entryRisk;
  }, 0) + offset * 0.001;
  return lanes.map((lane, offset) => ({ lane, score: score(lane, (offset - start + laneCount) % laneCount) }))
    .sort((a, b) => a.score - b.score)[0].lane;
}

class FloatingWord {
  constructor(wordToken, activeWords = []) {
    const token = typeof wordToken === "object" ? wordToken : { text: String(wordToken) };
    this.text = String(token.text || "");
    this.visual = getVisualProfile(token);
    const treatment = PhraseSelection.treatment(token);
    const sizeLimit = width * 0.76 / Math.max(1, this.text.length * 0.92);
    this.size = Math.min(sizeLimit, random(CONFIG.visual.wordMinSize, CONFIG.visual.wordMaxSize) * this.visual.scale * treatment.scale);
    this.halfWidth = Math.max(this.size, this.text.length * this.size * 0.48);
    this.direction = wordDirectionCursor % 2 === 0 ? -1 : 1;
    wordDirectionCursor += 1;
    this.x = this.direction < 0 ? width + this.halfWidth : -this.halfWidth;
    this.y = getNextWordLane(activeWords, this.direction);
    this.speed = CONFIG.visual.wordScrollSpeed * treatment.speed;
    this.expectedTravelMs = WordLifecycle.expectedTravelMs(width, this.halfWidth, this.speed);
    this.life = 1;
    this.progress = 0;
    this.alpha = 0;
    this.epoch = Number(token.epoch) || 0;
    this.createdAt = performance.now();
    this.lastMovementAt = this.createdAt;
    this.lastX = this.x;
  }

  update() {
    const now = performance.now();
    this.x = DanmakuMotion.advance(this.x, this.direction, this.speed, deltaTime);
    if (Math.abs(this.x - this.lastX) > 0.001) {
      this.lastMovementAt = now;
      this.lastX = this.x;
    }
    this.progress = DanmakuMotion.progress(this.x, this.direction, width, this.halfWidth);
    // Semantic changes never affect opacity. After a short entry fade the word stays crisp.
    this.alpha = WordLifecycle.alpha(this.progress, 255, CONFIG.visual.wordFadeInFraction);
    if (WordLifecycle.exited(this.x, this.direction, width, this.halfWidth) ||
        WordLifecycle.stalled(now, this.lastMovementAt, this.expectedTravelMs)) this.life = 0;
  }

  show() {
    push();
    translate(this.x, this.y);
    textAlign(CENTER, CENTER);
    textStyle(BOLD);
    textSize(this.size);
    colorMode(HSB, 360, 100, 100, 255);
    noStroke();

    fill(
      this.visual.hue,
      this.visual.saturation * 100,
      SignalMath.clamp(this.visual.brightness, 0, 1.5) * 66,
      this.alpha * 0.09 * this.visual.glow
    );
    for (let offset = 10; offset >= 2; offset -= 4) {
      text(this.text, random(-offset, offset) * 0.06, random(-offset, offset) * 0.06);
    }

    fill(
      this.visual.hue,
      Math.max(12, this.visual.saturation * 48),
      Math.min(100, this.visual.brightness * 86),
      this.alpha
    );
    text(this.text, 0, 0);
    pop();
  }
}
