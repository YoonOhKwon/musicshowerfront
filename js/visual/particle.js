class Particle {
  constructor() {
    const visual = getActiveVisualProfile();
    this.angle = random(TWO_PI);
    this.radius = random(95, 220);
    this.speed = random(1.4, 4.2) * (0.7 + visual.turbulence * 0.7);
    this.life = 255;
    this.hue = random() < 0.68 ? visual.primaryHue : visual.secondaryHue;
    this.saturation = 45 + visual.saturation * 50;
  }

  update() {
    this.radius += this.speed;
    this.angle += sin(frameCount * 0.01) * 0.0008;
    this.life -= 4;
  }

  show() {
    const x = width / 2 + cos(this.angle) * this.radius;
    const y = height / 2 + sin(this.angle) * this.radius;
    push();
    colorMode(HSB, 360, 100, 100, 255);
    noStroke();
    fill(this.hue, this.saturation, 100, this.life);
    circle(x, y, 2 + smoothBass * 0.028);
    pop();
  }
}
