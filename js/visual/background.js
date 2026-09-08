const THERMAL_BACKGROUND_VERTEX = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec2 vUv;
void main() {
  vUv = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}`;

const THERMAL_BACKGROUND_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBeat;
uniform float uImpact;
uniform float uNovelty;
uniform float uDeformation;
uniform float uTurbulence;
uniform float uContour;
uniform float uShimmer;
uniform float uHeat;
uniform float uHaze;
uniform float uRegularity;
uniform float uMotion;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 rotation = mat2(0.82, -0.57, 0.57, 0.82);
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise2(p);
    p = rotation * p * 2.03 + 7.1;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = vUv;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= uResolution.x / max(1.0, uResolution.y);
  float time = uTime * (0.055 + uMotion * 0.16);
  float lowerWeight = smoothstep(0.12, 1.0, uv.y);
  vec2 warpA = vec2(
    fbm(p * (1.25 + uMid * 0.45) + vec2(time, -time * 0.61)),
    fbm(p * 1.38 + vec2(-time * 0.72, time * 0.48))
  ) - 0.5;
  vec2 warpB = vec2(
    noise2(p * 3.1 + warpA * 2.2 + time),
    noise2(p * 2.7 - warpA * 2.5 - time * 0.8)
  ) - 0.5;
  float impactField = fbm(p * 1.15 + vec2(-time * 0.25, time * 0.17));
  vec2 impactDirection = vec2(noise2(p * 1.7 + 19.3), noise2(p * 1.43 - 8.7)) - 0.5;
  float viscousImpact = (impactField - 0.48) * uImpact * (0.45 + uBass * 0.7);
  vec2 warped = p + warpA * (0.28 + uDeformation * 0.72)
                  + warpB * (0.08 + uTurbulence * 0.42)
                  + impactDirection * viscousImpact * 0.72;
  warped.y += (noise2(vec2(p.x * 1.3, time * 0.35)) - 0.5) * uBass * 0.22 * lowerWeight;
  float field = fbm(warped * (1.9 + uContour * 1.3));
  field += noise2(warped * (5.4 + uMid * 2.2) - time * 1.3) * (0.1 + uTurbulence * 0.18);
  float bands = mix(7.0, 14.0, uContour);
  float isoPhase = abs(fract(field * bands + time * 0.32) - 0.5);
  float isolines = 1.0 - smoothstep(0.025, 0.11 + uHaze * 0.04, isoPhase);
  // Transients bend the existing noise field asymmetrically; no radial beat ring.
  field += (noise2(warped * 2.4 + impactDirection * 2.0) - 0.5) * uImpact * 0.22;
  float verticalHeat = pow(smoothstep(0.02, 1.0, uv.y), 1.42);
  verticalHeat = clamp(verticalHeat * (0.62 + uHeat * 0.62) + field * 0.28, 0.0, 1.0);
  vec3 shadow = vec3(0.010, 0.012, 0.022);
  vec3 deepPurple = vec3(0.12, 0.015, 0.13);
  vec3 magenta = vec3(0.78, 0.015, 0.34);
  vec3 crimson = vec3(1.0, 0.035, 0.18);
  vec3 orange = vec3(1.0, 0.24, 0.045);
  vec3 color = mix(shadow, deepPurple, smoothstep(0.02, 0.36, verticalHeat));
  color = mix(color, magenta, smoothstep(0.25, 0.62, verticalHeat));
  color = mix(color, crimson, smoothstep(0.54, 0.85, verticalHeat));
  color = mix(color, orange, smoothstep(0.82, 1.0, verticalHeat) * (0.45 + uHeat * 0.4));
  color += isolines * mix(vec3(0.25, 0.01, 0.16), vec3(1.0, 0.08, 0.31), verticalHeat)
           * (0.08 + uContour * 0.18 + uImpact * 0.08);
  float triadPhase = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y) * 2.0, 3.0);
  vec3 triad = triadPhase < 1.0 ? vec3(1.12, 0.77, 0.86)
             : triadPhase < 2.0 ? vec3(0.78, 1.04, 0.78)
             : vec3(0.78, 0.84, 1.13);
  float scan = 0.9 + 0.1 * sin(gl_FragCoord.y * 3.14159);
  float grain = hash21(gl_FragCoord.xy + floor(uTime * (8.0 + uHigh * 22.0)));
  color *= mix(vec3(1.0), triad * scan, 0.22 + uShimmer * 0.22);
  color += (grain - 0.5) * (0.018 + uShimmer * 0.038);
  float centerDistance = length((uv - 0.5) * vec2(1.0, 0.82));
  color *= 0.78 + smoothstep(0.08, 0.58, centerDistance) * 0.22;
  color *= 0.74 + verticalHeat * 0.26 + uEnergy * 0.08;
  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}`;

let thermalBackground = null;

class ThermalProceduralBackground {
  constructor() {
    this.mapper = new BackgroundAudioMapping.Mapper();
    const initialLevel = CONFIG.ml.quality === "performance" ? "low"
      : CONFIG.ml.quality === "balanced" ? "medium" : "high";
    this.governor = new BackgroundPerformance.Governor(initialLevel);
    this.profile = this.governor.profile();
    this.layer = null;
    this.shaderProgram = null;
    this.failed = false;
    this.lastRenderedFrame = -1;
    this.values = this.mapper.values;
    this.renderMs = 0;
    this.createLayer();
  }

  createLayer() {
    try {
      const targetWidth = Math.max(320, Math.round(width * this.profile.scale));
      const targetHeight = Math.max(180, Math.round(height * this.profile.scale));
      this.layer = createGraphics(targetWidth, targetHeight, WEBGL);
      this.layer.pixelDensity(1);
      this.layer.noStroke();
      this.shaderProgram = this.layer.createShader(THERMAL_BACKGROUND_VERTEX, THERMAL_BACKGROUND_FRAGMENT);
    } catch (error) {
      this.failed = true;
      console.warn("[background] procedural shader fallback", error.message);
    }
  }

  resizeIfNeeded(profile) {
    if (!this.layer) return;
    if (profile.scale !== this.profile.scale) {
      this.layer.resizeCanvas(
        Math.max(320, Math.round(width * profile.scale)),
        Math.max(180, Math.round(height * profile.scale))
      );
    }
    this.profile = profile;
  }

  update() {
    const state = getSemanticState();
    this.values = this.mapper.update({
      bass: smoothBass / 255,
      mid: smoothMid / 255,
      high: smoothHigh / 255,
      energy: smoothEnergy,
      beat: beatFlash,
      state
    }, deltaTime);
    this.resizeIfNeeded(this.governor.observe({
      fps: frameRate(),
      inferenceLatency: state.ml?.inferenceLatency || 0,
      longTaskMs: RuntimePerformance.snapshot().longTaskP90Ms,
      backgroundMs: this.renderMs
    }));
  }

  render() {
    const renderStartedAt = performance.now();
    this.update();
    if (this.failed || !this.layer || !this.shaderProgram) return this.renderFallback();
    const inferenceActive = getSemanticState().ml?.inferenceActive ||
      (typeof isDeepListenGpuBusy === "function" && isDeepListenGpuBusy());
    const frameStride = inferenceActive ? Math.max(2, this.profile.frameStride) : this.profile.frameStride;
    if (frameCount % frameStride !== 0 && this.lastRenderedFrame >= 0) {
      image(this.layer, 0, 0, width, height);
      this.recordRenderTime(renderStartedAt);
      return;
    }
    this.lastRenderedFrame = frameCount;
    const v = this.values;
    this.layer.shader(this.shaderProgram);
    this.shaderProgram.setUniform("uResolution", [this.layer.width, this.layer.height]);
    this.shaderProgram.setUniform("uTime", millis() / 1000);
    for (const [name, value] of Object.entries({
      Bass: v.bass, Mid: v.mid, High: v.high, Energy: v.energy, Beat: v.beat, Impact: v.impact,
      Novelty: v.novelty, Deformation: v.deformation, Turbulence: v.turbulence,
      Contour: v.contour, Shimmer: v.shimmer, Heat: v.heat, Haze: v.haze,
      Regularity: v.regularity, Motion: v.motion
    })) this.shaderProgram.setUniform(`u${name}`, Number(value) || 0);
    this.layer.rect(-this.layer.width / 2, -this.layer.height / 2, this.layer.width, this.layer.height);
    image(this.layer, 0, 0, width, height);
    this.recordRenderTime(renderStartedAt);
  }

  recordRenderTime(startedAt) {
    const measured = performance.now() - startedAt;
    this.renderMs += (measured - this.renderMs) * 0.16;
    RuntimePerformance.recordBackground(measured);
  }

  renderFallback() {
    const startedAt = performance.now();
    const v = this.values;
    push();
    colorMode(RGB, 255);
    background(5, 3, 12);
    noStroke();
    const layers = 18;
    for (let index = layers; index > 0; index--) {
      const phase = index / layers;
      const wobble = sin(millis() * 0.00012 + index * 1.7) * width * (0.03 + v.deformation * 0.035);
      fill(75 + phase * 180, 2 + phase * 28, 44 + phase * 22, 14 + v.energy * 10);
      ellipse(width * (0.5 + (phase - 0.5) * 0.35) + wobble,
        height * (0.62 + cos(index * 1.23) * 0.11), width * (0.5 + phase * 0.75 + v.impact * 0.2),
        height * (0.3 + phase * 0.52 + v.bass * 0.18));
    }
    pop();
    this.recordRenderTime(startedAt);
  }

  debugState() {
    return { ...this.values, quality: this.profile.level, shader: !this.failed, renderMs: this.renderMs };
  }
}

function initializeBackground() {
  thermalBackground?.layer?.remove();
  thermalBackground = new ThermalProceduralBackground();
}

function drawBackground() {
  thermalBackground?.render();
}

function getBackgroundDebugState() {
  return thermalBackground?.debugState() || {};
}
