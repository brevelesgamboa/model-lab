import { clamp } from "../core/utils.js";

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  vec2 position = positions[gl_VertexID];
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_seed_b;
uniform float u_seed_mix;
uniform float u_p0;
uniform float u_p1;
uniform float u_p2;
uniform float u_p3;
uniform float u_p4;
uniform float u_p5;
uniform float u_p6;
uniform float u_p7;
uniform float u_p8;
uniform float u_p9;
uniform int u_variant;

in vec2 v_uv;
out vec4 out_color;

const float PI = 3.141592653589793;

float blendedSeed() {
  float amount = u_seed_mix * u_seed_mix * (3.0 - 2.0 * u_seed_mix);
  return mix(u_seed, u_seed_b, amount);
}

mat2 rotate2d(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + blendedSeed());
  return fract(p.x * p.y);
}

vec3 harmonicPalette(float t, float chroma) {
  vec3 phase = vec3(0.02, 0.34 + chroma * 0.10, 0.66 - chroma * 0.08);
  return 0.5 + 0.5 * cos(6.2831853 * (t + phase));
}

vec3 chromaticField(vec2 uv) {
  float frequency = u_p0;
  float warp = u_p1;
  float chroma = u_p2;
  float symmetry = u_p3;
  float feedback = u_p4;
  float grain = u_p5;
  float rotation = u_p6;
  float velocity = u_p7;
  float time = u_time * velocity;
  float warpTime = time;

  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;
  p = rotate2d(rotation) * p;
  vec2 mirrored = mix(p, abs(p), symmetry);

  vec2 q = mirrored;
  q += warp * 0.17 * vec2(
    sin(q.y * frequency * 0.83 + warpTime + blendedSeed() * 0.01),
    cos(q.x * frequency * 0.77 - warpTime * 0.91 + blendedSeed() * 0.013)
  );
  q += warp * 0.09 * vec2(
    sin((q.x + q.y) * frequency * 1.31 - warpTime * 0.7),
    cos((q.x - q.y) * frequency * 1.17 + warpTime * 0.62)
  );

  float signalA = sin((q.x + sin(q.y * 1.7)) * frequency + time);
  float signalB = cos((q.y + cos(q.x * 1.9)) * frequency * 0.86 - time * 0.77);
  float radial = sin(length(q) * frequency * (1.7 + feedback) - time * 1.3);
  float interference = (signalA + signalB + radial * feedback) / (2.0 + feedback);
  float bands = sin((q.x * q.y) * frequency * 2.3 + time * 0.35);
  float value = interference * 0.67 + bands * 0.33;

  vec3 color = harmonicPalette(value * 0.28 + time * 0.025 + blendedSeed() * 0.0007, chroma);
  float neutral = 0.5 + 0.5 * value;
  color = mix(vec3(neutral), color, chroma);
  color *= 0.78 + 0.34 * (0.5 + 0.5 * radial);
  color += (hash21(gl_FragCoord.xy + floor(time * 30.0)) - 0.5) * grain;
  color = pow(max(color, 0.0), vec3(0.92));
  return clamp(color, 0.0, 1.0);
}

vec3 foldedFractal(vec2 uv) {
  int iterations = int(clamp(floor(u_p0 + 0.5), 2.0, 12.0));
  float scale = u_p1;
  float rotation = u_p2;
  float gain = u_p3;
  float chroma = u_p4;
  float pulse = u_p5;
  float symmetry = u_p6;
  float grain = u_p7;
  float ghosting = u_p8;
  float paletteShift = u_p9;
  float time = u_time * pulse;

  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;
  p *= scale;
  p = rotate2d(rotation + sin(time * 0.27) * 0.18) * p;

  float accumulation = 0.0;
  float orbit = 10.0;
  float echoOrbit = 10.0;
  float angleAccumulator = 0.0;

  for (int index = 0; index < 12; index += 1) {
    if (index >= iterations) break;
    float fi = float(index);
    p = mix(p, abs(p), symmetry);
    float radiusSquared = max(dot(p, p), 0.075);
    p = abs(p) / radiusSquared - vec2(0.78 + 0.08 * sin(blendedSeed() * 0.01), 0.52 + 0.07 * cos(blendedSeed() * 0.013));
    p = rotate2d(rotation * 0.31 + 0.19 + sin(time * 0.2 + fi) * 0.025) * p;
    float ring = abs(length(p) - (0.72 + 0.08 * sin(time + fi)));
    orbit = min(orbit, ring);
    vec2 echoOffset = vec2(sin(time * 0.43 + fi), cos(time * 0.37 - fi)) * 0.12 * ghosting;
    float echoRing = abs(length(p + echoOffset) - (0.72 + 0.08 * sin(time + fi)));
    echoOrbit = min(echoOrbit, echoRing);
    accumulation += exp(-ring * (5.0 + gain * 4.0)) * gain / (1.0 + fi * 0.42);
    angleAccumulator += atan(p.y, p.x) * 0.055;
  }

  float line = exp(-orbit * (18.0 + gain * 8.0));
  float structure = accumulation * 0.58 + line * 0.86;
  float modulation = 0.5 + 0.5 * sin(angleAccumulator * 12.0 + time + length(p));
  vec3 color = harmonicPalette(structure * 0.34 + modulation * 0.18 + time * 0.018 + paletteShift, chroma);
  color = mix(vec3(structure * 0.48), color * structure, 0.44 + chroma * 0.56);
  color += line * vec3(0.34, 0.18 + chroma * 0.42, 0.55);
  float ghostLine = exp(-echoOrbit * (14.0 + gain * 6.0)) * ghosting;
  color += ghostLine * vec3(0.10, 0.20, 0.46) * 0.32;
  color += (hash21(gl_FragCoord.xy + floor(time * 24.0)) - 0.5) * grain;
  return clamp(color, 0.0, 1.0);
}

void main() {
  vec3 color;
  if (u_variant == 0) color = chromaticField(v_uv);
  else color = foldedFractal(v_uv);
  out_color = vec4(color, 1.0);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message =
      gl.getProgramInfoLog(program) || "Shader program linking failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function cosinePalette(value, chroma) {
  const phases = [0.02, 0.34 + chroma * 0.1, 0.66 - chroma * 0.08];
  return phases.map(
    (phase) => 0.5 + 0.5 * Math.cos(Math.PI * 2 * (value + phase)),
  );
}

function rotatePoint(x, y, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine * x - sine * y, sine * x + cosine * y];
}

class GpuFieldModel {
  constructor(variant) {
    this.variant = variant;
    if (typeof variant.randomize === "function") {
      this.randomizeParameters = variant.randomize;
    }
    this.gpuCanvas = document.createElement("canvas");
    this.gpuCanvas.width = 512;
    this.gpuCanvas.height = 512;
    this.cpuCanvas = document.createElement("canvas");
    this.cpuCanvas.width = 192;
    this.cpuCanvas.height = this.cpuCanvas.width;
    this.cpuContext = this.cpuCanvas.getContext("2d", { alpha: false });
    this.gl = null;
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.initializeWebGl();
  }

  initializeWebGl() {
    try {
      const gl = this.gpuCanvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance",
      });
      if (!gl) return;
      const program = createProgram(gl);
      const names = [
        "u_resolution",
        "u_time",
        "u_seed",
        "u_seed_b",
        "u_seed_mix",
        "u_p0",
        "u_p1",
        "u_p2",
        "u_p3",
        "u_p4",
        "u_p5",
        "u_p6",
        "u_p7",
        "u_p8",
        "u_p9",
        "u_variant",
      ];
      this.uniforms = Object.fromEntries(
        names.map((name) => [name, gl.getUniformLocation(program, name)]),
      );
      this.vao = gl.createVertexArray();
      this.gl = gl;
      this.program = program;
    } catch (error) {
      console.warn(`${this.variant.name} could not initialize WebGL2.`, error);
      this.gl = null;
      this.program = null;
    }
  }

  get id() {
    return this.variant.id;
  }
  get name() {
    return this.variant.name;
  }
  get family() {
    return this.variant.family;
  }
  get backend() {
    return this.gl ? "WEBGL2 / FRAGMENT_SHADER" : "CPU / CANVAS_2D FALLBACK";
  }
  get description() {
    return this.variant.description;
  }
  get animated() {
    return true;
  }
  get available() {
    return true;
  }
  get pixelated() {
    return false;
  }
  get controls() {
    return this.variant.controls;
  }
  get presets() {
    return this.variant.presets || [];
  }

  isDynamic(parameters) {
    return this.variant.isDynamic ? this.variant.isDynamic(parameters) : true;
  }

  mapParameters(parameters) {
    return this.variant.map(parameters);
  }

  render(targetCanvas, parameters, timeSeconds = 0) {
    const started = performance.now();
    const mapped = this.mapParameters(parameters);
    if (this.gl)
      this.renderWebGl(targetCanvas, parameters, mapped, timeSeconds);
    else this.renderCpu(targetCanvas, parameters, mapped, timeSeconds);

    return {
      backend: this.backend,
      modelMetrics: this.variant.metrics(parameters),
      inferenceMs: performance.now() - started,
    };
  }

  renderWebGl(targetCanvas, parameters, mapped, timeSeconds) {
    const gl = this.gl;
    if (
      this.gpuCanvas.width !== targetCanvas.width ||
      this.gpuCanvas.height !== targetCanvas.height
    ) {
      this.gpuCanvas.width = targetCanvas.width;
      this.gpuCanvas.height = targetCanvas.height;
    }

    gl.viewport(0, 0, this.gpuCanvas.width, this.gpuCanvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(
      this.uniforms.u_resolution,
      this.gpuCanvas.width,
      this.gpuCanvas.height,
    );
    gl.uniform1f(this.uniforms.u_time, timeSeconds);
    const baseSeed = Number(parameters.seed) || 1;
    const seedMix = clamp(Number(parameters.__seedMix) || 0, 0, 1);
    gl.uniform1f(this.uniforms.u_seed, baseSeed);
    gl.uniform1f(
      this.uniforms.u_seed_b,
      Number(parameters.__seedB) || baseSeed,
    );
    gl.uniform1f(this.uniforms.u_seed_mix, seedMix);
    for (let index = 0; index < 10; index += 1) {
      gl.uniform1f(this.uniforms[`u_p${index}`], Number(mapped[index]) || 0);
    }
    gl.uniform1i(this.uniforms.u_variant, this.variant.shaderVariant);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();

    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
    context.fillStyle = "#000";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(
      this.gpuCanvas,
      0,
      0,
      targetCanvas.width,
      targetCanvas.height,
    );
    context.restore();
  }

  renderCpu(targetCanvas, parameters, mapped, timeSeconds) {
    const width = this.cpuCanvas.width;
    const height = this.cpuCanvas.height;
    const image = this.cpuContext.createImageData(width, height);
    const baseSeed = Number(parameters.seed) || 1;
    const seedAmount = clamp(Number(parameters.__seedMix) || 0, 0, 1);
    const smoothSeed = seedAmount * seedAmount * (3 - 2 * seedAmount);
    const seed =
      baseSeed +
      ((Number(parameters.__seedB) || baseSeed) - baseSeed) * smoothSeed;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const uvX = x / width;
        const uvY = y / height;
        let color;
        if (this.variant.shaderVariant === 0)
          color = this.cpuChromatic(uvX, uvY, mapped, timeSeconds, seed);
        else color = this.cpuFolded(uvX, uvY, mapped, timeSeconds, seed);
        const offset = (y * width + x) * 4;
        image.data[offset] = Math.round(clamp(color[0]) * 255);
        image.data[offset + 1] = Math.round(clamp(color[1]) * 255);
        image.data[offset + 2] = Math.round(clamp(color[2]) * 255);
        image.data[offset + 3] = 255;
      }
    }

    this.cpuContext.putImageData(image, 0, 0);
    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
    context.fillStyle = "#000";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(
      this.cpuCanvas,
      0,
      0,
      targetCanvas.width,
      targetCanvas.height,
    );
    context.restore();
  }

  cpuChromatic(uvX, uvY, p, timeSeconds, seed) {
    const [
      frequency,
      warp,
      chroma,
      symmetry,
      feedback,
      grain,
      rotation,
      velocity,
    ] = p;
    const time = timeSeconds * velocity;
    const warpTime = time;
    let px = uvX * 2 - 1;
    let py = uvY * 2 - 1;
    [px, py] = rotatePoint(px, py, rotation);
    px = px * (1 - symmetry) + Math.abs(px) * symmetry;
    py = py * (1 - symmetry) + Math.abs(py) * symmetry;
    const qx =
      px +
      warp * 0.17 * Math.sin(py * frequency * 0.83 + warpTime + seed * 0.01);
    const qy =
      py +
      warp *
        0.17 *
        Math.cos(px * frequency * 0.77 - warpTime * 0.91 + seed * 0.013);
    const signalA = Math.sin((qx + Math.sin(qy * 1.7)) * frequency + time);
    const signalB = Math.cos(
      (qy + Math.cos(qx * 1.9)) * frequency * 0.86 - time * 0.77,
    );
    const radial = Math.sin(
      Math.hypot(qx, qy) * frequency * (1.7 + feedback) - time * 1.3,
    );
    const interference =
      (signalA + signalB + radial * feedback) / (2 + feedback);
    const bands = Math.sin(qx * qy * frequency * 2.3 + time * 0.35);
    const value = interference * 0.67 + bands * 0.33;
    const palette = cosinePalette(
      value * 0.28 + time * 0.025 + seed * 0.0007,
      chroma,
    );
    const neutral = 0.5 + 0.5 * value;
    const color = palette.map(
      (channel) => neutral * (1 - chroma) + channel * chroma,
    );
    const luminance = 0.78 + 0.34 * (0.5 + 0.5 * radial);
    const noise =
      (Math.sin((uvX * 913 + uvY * 571 + time * 23 + seed) * 12.9898) *
        43758.5453) %
      1;
    return color.map(
      (channel) =>
        channel * luminance + (noise - Math.floor(noise) - 0.5) * grain,
    );
  }

  cpuFolded(uvX, uvY, p, timeSeconds, seed) {
    const [
      iterationValue,
      scale,
      rotation,
      gain,
      chroma,
      pulse,
      symmetry,
      grain,
      ghosting,
      paletteShift,
    ] = p;
    const iterations = Math.max(2, Math.min(12, Math.round(iterationValue)));
    const time = timeSeconds * pulse;
    let px = (uvX * 2 - 1) * scale;
    let py = (uvY * 2 - 1) * scale;
    [px, py] = rotatePoint(px, py, rotation + Math.sin(time * 0.27) * 0.18);
    let accumulation = 0;
    let orbit = 10;
    let echoOrbit = 10;
    let angleAccumulator = 0;
    for (let index = 0; index < iterations; index += 1) {
      px = px * (1 - symmetry) + Math.abs(px) * symmetry;
      py = py * (1 - symmetry) + Math.abs(py) * symmetry;
      const radiusSquared = Math.max(px * px + py * py, 0.075);
      px = Math.abs(px) / radiusSquared - (0.78 + 0.08 * Math.sin(seed * 0.01));
      py =
        Math.abs(py) / radiusSquared - (0.52 + 0.07 * Math.cos(seed * 0.013));
      [px, py] = rotatePoint(
        px,
        py,
        rotation * 0.31 + 0.19 + Math.sin(time * 0.2 + index) * 0.025,
      );
      const ring = Math.abs(
        Math.hypot(px, py) - (0.72 + 0.08 * Math.sin(time + index)),
      );
      orbit = Math.min(orbit, ring);
      const echoX = px + Math.sin(time * 0.43 + index) * 0.12 * ghosting;
      const echoY = py + Math.cos(time * 0.37 - index) * 0.12 * ghosting;
      const echoRing = Math.abs(
        Math.hypot(echoX, echoY) - (0.72 + 0.08 * Math.sin(time + index)),
      );
      echoOrbit = Math.min(echoOrbit, echoRing);
      accumulation +=
        (Math.exp(-ring * (5 + gain * 4)) * gain) / (1 + index * 0.42);
      angleAccumulator += Math.atan2(py, px) * 0.035;
    }
    const line = Math.exp(-orbit * (18 + gain * 8));
    const structure = accumulation * 0.58 + line * 0.86;
    const modulation =
      0.5 + 0.5 * Math.sin(angleAccumulator * 12 + time + Math.hypot(px, py));
    const palette = cosinePalette(
      structure * 0.34 + modulation * 0.18 + time * 0.018 + paletteShift,
      chroma,
    );
    const grayscale = structure * 0.48;
    const color = palette.map(
      (channel) =>
        grayscale * (1 - (0.44 + chroma * 0.56)) +
        channel * structure * (0.44 + chroma * 0.56),
    );
    color[0] += line * 0.34;
    color[1] += line * (0.18 + chroma * 0.42);
    color[2] += line * 0.55;
    const ghostLine = Math.exp(-echoOrbit * (14 + gain * 6)) * ghosting * 0.32;
    color[0] += ghostLine * 0.1;
    color[1] += ghostLine * 0.2;
    color[2] += ghostLine * 0.46;
    const noise =
      (Math.sin((uvX * 743 + uvY * 997 + time * 17 + seed) * 7.133) *
        12453.31) %
      1;
    return color.map(
      (channel) => channel + (noise - Math.floor(noise) - 0.5) * grain,
    );
  }
}

const chromaticVariant = {
  id: "chromatic-field",
  name: "Chromatic Flow",
  family: "Generative signal field",
  shaderVariant: 0,
  description:
    "Periodic functions, coordinate warping, radial feedback, and phase motion produce a live color field. Grain starts at zero, so the initial image is clean.",
  controls: [
    {
      key: "seed",
      label: "RANDOM SEED",
      type: "number",
      min: 1,
      max: 999999,
      step: 1,
      default: 38141,
    },
    {
      key: "frequency",
      label: "SPATIAL FREQUENCY",
      type: "range",
      min: 1,
      max: 14,
      step: 0.1,
      default: 5.8,
      format: "decimal1",
    },
    {
      key: "warp",
      label: "DOMAIN WARP",
      type: "range",
      min: 0,
      max: 2.5,
      step: 0.01,
      default: 1.15,
      format: "decimal2",
    },
    {
      key: "chroma",
      label: "CHROMATIC SEPARATION",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.82,
      format: "percent",
    },
    {
      key: "symmetry",
      label: "MIRROR FOLD",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
      format: "percent",
    },
    {
      key: "feedback",
      label: "RADIAL FEEDBACK",
      type: "range",
      min: 0,
      max: 1.5,
      step: 0.01,
      default: 0.74,
      format: "decimal2",
    },
    {
      key: "grain",
      label: "SIGNAL GRAIN",
      type: "range",
      min: 0,
      max: 0.35,
      step: 0.01,
      default: 0,
      format: "percent",
    },
    {
      key: "rotation",
      label: "FIELD ROTATION",
      type: "range",
      min: 0,
      max: 360,
      step: 1,
      default: 18,
      format: "degrees",
    },
    {
      key: "velocity",
      label: "PHASE VELOCITY",
      type: "range",
      min: 0,
      max: 2,
      step: 0.01,
      fineStep: 0.001,
      default: 0,
      format: "decimal2",
    },
  ],
  map: (parameters) => [
    clamp(parameters.frequency, 1, 14),
    clamp(parameters.warp, 0, 2.5),
    clamp(parameters.chroma, 0, 1),
    clamp(parameters.symmetry, 0, 1),
    clamp(parameters.feedback, 0, 1.5),
    clamp(parameters.grain, 0, 0.35),
    (clamp(parameters.rotation, 0, 360) * Math.PI) / 180,
    clamp(parameters.velocity, 0, 2),
  ],
  isDynamic: (parameters) => Number(parameters.velocity) > 0.001,
  metrics: (parameters) => ({
    spatialFrequency: Number(parameters.frequency),
    domainWarp: Number(parameters.warp),
    chromaticSeparation: Number(parameters.chroma),
    phaseVelocity: Number(parameters.velocity),
  }),
};

const foldedVariant = {
  id: "folded-fractal",
  name: "Folded Fractal",
  family: "Iterative coordinate transform",
  shaderVariant: 1,
  description:
    "Repeated coordinate folding, rotation, inversion, translation, symmetry, and feedback-like iteration create continually transforming geometric structures. Small changes can produce major structural shifts.",
  controls: [
    {
      key: "seed",
      label: "RANDOM SEED",
      type: "number",
      min: 1,
      max: 999999,
      step: 1,
      default: 77403,
    },
    {
      key: "iterations",
      label: "RECURSION DEPTH",
      type: "range",
      min: 2,
      max: 12,
      step: 1,
      default: 8,
      format: "integer",
    },
    {
      key: "scale",
      label: "COORDINATE SCALE",
      type: "range",
      min: 0.8,
      max: 4,
      step: 0.01,
      default: 1.85,
      format: "decimal2",
    },
    {
      key: "rotation",
      label: "ITERATION ROTATION",
      type: "range",
      min: 0,
      max: 360,
      step: 1,
      default: 31,
      format: "degrees",
    },
    {
      key: "gain",
      label: "ORBIT GAIN",
      type: "range",
      min: 0.2,
      max: 1.6,
      step: 0.01,
      default: 0.92,
      format: "decimal2",
    },
    {
      key: "chroma",
      label: "CHROMATIC RESPONSE",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.78,
      format: "percent",
    },
    {
      key: "palette",
      label: "COLOR PHASE",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.57,
      format: "percent",
    },
    {
      key: "pulse",
      label: "TEMPORAL PULSE",
      type: "range",
      min: 0,
      max: 2,
      step: 0.01,
      fineStep: 0.001,
      default: 0.42,
      format: "decimal2",
    },
    {
      key: "symmetry",
      label: "ABSOLUTE FOLD",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.88,
      format: "percent",
    },
    {
      key: "grain",
      label: "SIGNAL GRAIN",
      type: "range",
      min: 0,
      max: 0.25,
      step: 0.01,
      default: 0.03,
      format: "percent",
    },
    {
      key: "ghosting",
      label: "GHOST EFFECT",
      type: "range",
      min: 0,
      max: 0.85,
      step: 0.01,
      default: 0,
      format: "percent",
    },
  ],
  map: (parameters) => [
    clamp(parameters.iterations, 2, 12),
    clamp(parameters.scale, 0.8, 4),
    (clamp(parameters.rotation, 0, 360) * Math.PI) / 180,
    clamp(parameters.gain, 0.2, 1.6),
    clamp(parameters.chroma, 0, 1),
    clamp(parameters.pulse, 0, 2),
    clamp(parameters.symmetry, 0, 1),
    clamp(parameters.grain, 0, 0.25),
    clamp(parameters.ghosting, 0, 0.85),
    clamp(parameters.palette, 0, 1),
  ],
  isDynamic: (parameters) => Number(parameters.pulse) > 0.001,
  metrics: (parameters) => ({
    recursionDepth: Number(parameters.iterations),
    coordinateScale: Number(parameters.scale),
    orbitGain: Number(parameters.gain),
    temporalPulse: Number(parameters.pulse),
  }),
};

export function createGpuModels() {
  return [
    new GpuFieldModel(chromaticVariant),
    new GpuFieldModel(foldedVariant),
  ];
}
