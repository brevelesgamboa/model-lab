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
precision highp int;

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform vec2 u_julia;
uniform float u_zoom;
uniform float u_escape;
uniform float u_palette;
uniform float u_cycles;
uniform float u_trap;
uniform float u_time;
uniform float u_drift;
uniform int u_equation;
uniform int u_iterations;

in vec2 v_uv;
out vec4 out_color;

vec3 palette(float t) {
  vec3 a = vec3(0.50);
  vec3 b = vec3(0.50);
  vec3 c = vec3(1.0, 0.93, 0.82);
  vec3 d = vec3(0.00 + u_palette, 0.22 + u_palette * 0.45, 0.52 - u_palette * 0.32);
  return a + b * cos(6.2831853 * (c * t + d));
}

vec2 complexSquare(vec2 z) {
  return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
}

void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;
  p /= max(u_zoom, 0.000001);
  vec2 drift = vec2(cos(u_time * 0.23), sin(u_time * 0.19)) * u_drift / max(u_zoom, 1.0) * 0.18;
  p += u_center + drift;

  vec2 z = vec2(0.0);
  vec2 c = p;
  if (u_equation == 1) {
    z = p;
    c = u_julia + vec2(sin(u_time * 0.17), cos(u_time * 0.13)) * u_drift * 0.035;
  }

  float escapedAt = -1.0;
  float orbit = 1000.0;
  float magnitudeSquared = 0.0;

  for (int iteration = 0; iteration < 700; iteration += 1) {
    if (iteration >= u_iterations) break;
    if (u_equation == 2) {
      z = complexSquare(vec2(z.x, -z.y)) + c;
    } else if (u_equation == 3) {
      vec2 folded = abs(z);
      z = complexSquare(folded) + c;
    } else {
      z = complexSquare(z) + c;
    }

    magnitudeSquared = dot(z, z);
    float lineTrap = min(abs(z.x), abs(z.y));
    float ringTrap = abs(length(z) - 0.5);
    orbit = min(orbit, mix(lineTrap, ringTrap, u_trap));
    if (magnitudeSquared > u_escape * u_escape) {
      escapedAt = float(iteration);
      break;
    }
  }

  vec3 color;
  if (escapedAt < 0.0) {
    float interior = exp(-orbit * (8.0 + u_cycles));
    color = mix(vec3(0.006, 0.005, 0.009), palette(u_palette + interior * 0.12) * 0.22, interior);
  } else {
    float smoothIteration = escapedAt + 1.0 - log2(max(1.0, log2(max(2.0, sqrt(magnitudeSquared)))));
    float normalized = smoothIteration / float(max(u_iterations, 1));
    float bands = normalized * u_cycles;
    float trapGlow = exp(-orbit * (12.0 + u_cycles * 2.0));
    color = palette(bands + u_palette + trapGlow * 0.11);
    color *= 0.28 + 0.92 * pow(clamp(normalized * 3.2, 0.0, 1.0), 0.45);
    color += trapGlow * vec3(0.28, 0.12, 0.42);
  }

  color = pow(max(color, 0.0), vec3(0.88));
  out_color = vec4(clamp(color, 0.0, 1.0), 1.0);
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

function palette(value, shift) {
  const phases = [0 + shift, 0.22 + shift * 0.45, 0.52 - shift * 0.32];
  return phases.map((phase, index) => {
    const frequency = [1, 0.93, 0.82][index];
    return 0.5 + 0.5 * Math.cos(Math.PI * 2 * (frequency * value + phase));
  });
}

function squareComplex(x, y) {
  return [x * x - y * y, 2 * x * y];
}

const EQUATIONS = ["MANDELBROT", "JULIA", "TRICORN", "BURNING SHIP"];

const CURATED_VIEWS = {
  0: [
    { centerX: -0.743643887, centerY: 0.1318259042, zoomExponent: 3.05 },
    { centerX: -0.1010963638, centerY: 0.9562865108, zoomExponent: 2.25 },
    { centerX: -1.25066, centerY: 0.02012, zoomExponent: 2.1 },
    { centerX: -0.7453, centerY: 0.1127, zoomExponent: 2.55 },
    { centerX: -0.16070135, centerY: 1.0375665, zoomExponent: 2.15 },
    { centerX: -0.77568377, centerY: 0.13664085, zoomExponent: 2.75 },
  ],
  1: [
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.18,
      juliaReal: -0.745,
      juliaImag: 0.113,
    },
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.2,
      juliaReal: -0.8,
      juliaImag: 0.156,
    },
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.12,
      juliaReal: 0.285,
      juliaImag: 0.01,
    },
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.2,
      juliaReal: -0.4,
      juliaImag: 0.6,
    },
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.18,
      juliaReal: 0.355,
      juliaImag: 0.355,
    },
    {
      centerX: 0.0,
      centerY: 0.0,
      zoomExponent: 0.26,
      juliaReal: -0.70176,
      juliaImag: -0.3842,
    },
  ],
  2: [
    { centerX: -0.21, centerY: 0.71, zoomExponent: 1.3 },
    { centerX: -0.425, centerY: 0.575, zoomExponent: 1.75 },
    { centerX: -0.015, centerY: 0.76, zoomExponent: 1.55 },
    { centerX: -0.33, centerY: -0.625, zoomExponent: 1.45 },
    { centerX: -0.585, centerY: 0.485, zoomExponent: 2.05 },
  ],
  3: [
    { centerX: -1.7443359375, centerY: -0.0174511719, zoomExponent: 2.9 },
    { centerX: -1.8611, centerY: -0.0051, zoomExponent: 2.4 },
    { centerX: -1.768, centerY: -0.045, zoomExponent: 2.3 },
    { centerX: -1.85, centerY: 0.027, zoomExponent: 2.05 },
    { centerX: -1.94, centerY: -0.005, zoomExponent: 1.65 },
  ],
};

function randomBetween(random, minimum, maximum) {
  return minimum + random() * (maximum - minimum);
}

function choose(random, values) {
  return values[
    Math.min(values.length - 1, Math.floor(random() * values.length))
  ];
}

function wrapUnit(value) {
  return ((Number(value) % 1) + 1) % 1;
}

function circularMixUnit(a, b, amount) {
  let delta = wrapUnit(b) - wrapUnit(a);
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  return wrapUnit(Number(a) + delta * amount);
}

export class FractalFunctionModel {
  constructor() {
    this.gpuCanvas = document.createElement("canvas");
    this.gpuCanvas.width = 512;
    this.gpuCanvas.height = 512;
    this.cpuCanvas = document.createElement("canvas");
    this.cpuCanvas.width = 320;
    this.cpuCanvas.height = 320;
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
      const uniformNames = [
        "u_resolution",
        "u_center",
        "u_julia",
        "u_zoom",
        "u_escape",
        "u_palette",
        "u_cycles",
        "u_trap",
        "u_time",
        "u_drift",
        "u_equation",
        "u_iterations",
      ];
      this.uniforms = Object.fromEntries(
        uniformNames.map((name) => [
          name,
          gl.getUniformLocation(program, name),
        ]),
      );
      this.vao = gl.createVertexArray();
      this.gl = gl;
      this.program = program;
    } catch (error) {
      console.warn("Fractal WebGL2 initialization failed.", error);
      this.gl = null;
      this.program = null;
    }
  }

  get id() {
    return "fractal-functions";
  }
  get name() {
    return "Fractal Explorer";
  }
  get family() {
    return "Complex fractal system";
  }
  get backend() {
    return this.gl ? "WEBGL2 / FRACTAL_SHADER" : "CPU / CANVAS_2D FALLBACK";
  }
  get description() {
    return "Mandelbrot, Julia, Tricorn, and Burning Ship equations expose iteration, escape time, orbit traps, zoom, and parameter sensitivity. Parameter LFO modulation and audio reactivity keep the view active without changing its base state.";
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
  isDynamic(parameters) {
    return Number(parameters?.drift) > 0.001;
  }

  get controls() {
    return [
      {
        key: "equation",
        label: "FUNCTION FAMILY",
        type: "select",
        default: 0,
        options: EQUATIONS.map((label, value) => ({ value, label })),
        info: {
          description:
            "Chooses the complex-number recurrence used to classify each pixel. Mandelbrot changes c per pixel; Julia holds c fixed; Tricorn conjugates the imaginary component; Burning Ship folds both components before squaring.",
          extremes:
            "Changing families can replace the entire topology, so state interpolation between different families switches discretely near the midpoint.",
          lfo: "This is a discrete selector and cannot receive an LFO.",
        },
      },
      {
        key: "iterations",
        label: "ITERATION BUDGET",
        type: "range",
        min: 30,
        max: 700,
        step: 1,
        fineStep: 1,
        default: 200,
        format: "integer",
        info: {
          description:
            "Maximum number of recurrence steps evaluated for every pixel before it is considered part of the interior.",
          extremes:
            "Low values render quickly but flatten delicate boundaries. High values reveal deep zoom detail and resolve delicate boundary filaments.",
          lfo: "Slow modulation can make fine boundary detail appear and disappear, but large depths may change performance from frame to frame.",
        },
      },
      {
        key: "zoomExponent",
        label: "ZOOM EXPONENT (10^X)",
        type: "range",
        min: -0.2,
        max: 5.5,
        step: 0.01,
        fineStep: 0.001,
        default: 0.15,
        format: "decimal2",
        info: {
          description:
            "Controls magnification logarithmically. A value of 3 means approximately 1,000x zoom, while 5 means approximately 100,000x.",
          extremes:
            "High-precision hardware shader rendering reveals delicate self-similar boundary structures.",
          lfo: "Use a low rate and shallow depth for breathing zoom. Deep, fast modulation can jump across many orders of magnitude.",
        },
      },
      {
        key: "centerX",
        label: "CENTER REAL",
        type: "range",
        min: -2.5,
        max: 1.5,
        step: 0.001,
        fineStep: 0.0001,
        default: -0.72,
        format: "decimal3",
        info: {
          description:
            "Moves the viewport horizontally across the real axis of the complex plane.",
          extremes:
            "At deep zoom, tiny changes become enormous movements. Use the exact-value box for fine navigation.",
          lfo: "A very small depth creates horizontal orbiting. Reduce depth as zoom increases.",
        },
      },
      {
        key: "centerY",
        label: "CENTER IMAGINARY",
        type: "range",
        min: -1.7,
        max: 1.7,
        step: 0.001,
        fineStep: 0.0001,
        default: 0,
        format: "decimal3",
        info: {
          description:
            "Moves the viewport vertically across the imaginary axis of the complex plane.",
          extremes:
            "Deep zooms amplify minute changes. Pair this with CENTER REAL to locate boundary structures.",
          lfo: "A small phase offset from CENTER REAL creates circular or elliptical camera motion.",
        },
      },
      {
        key: "juliaReal",
        label: "JULIA CONSTANT REAL",
        type: "range",
        min: -1.5,
        max: 1.5,
        step: 0.001,
        fineStep: 0.0001,
        default: -0.745,
        format: "decimal3",
        info: {
          description:
            "Real component of the fixed Julia constant c. It is primarily used when FUNCTION FAMILY is JULIA.",
          extremes:
            "Small changes can split connected forms into dust or merge islands into filaments.",
          lfo: "Slow shallow modulation continuously changes the Julia topology instead of merely moving the camera.",
        },
      },
      {
        key: "juliaImag",
        label: "JULIA CONSTANT IMAGINARY",
        type: "range",
        min: -1.5,
        max: 1.5,
        step: 0.001,
        fineStep: 0.0001,
        default: 0.113,
        format: "decimal3",
        info: {
          description: "Imaginary component of the fixed Julia constant c.",
          extremes:
            "Together with JULIA CONSTANT REAL, this chooses the dynamical system rather than a viewing position.",
          lfo: "Pair with JULIA CONSTANT REAL at a different phase to trace a path through Julia-set space.",
        },
      },
      {
        key: "escapeRadius",
        label: "ESCAPE RADIUS",
        type: "range",
        min: 2,
        max: 16,
        step: 0.1,
        fineStep: 0.01,
        default: 4,
        format: "decimal1",
        info: {
          description:
            "Magnitude threshold used to decide that an orbit is escaping toward infinity.",
          extremes:
            "Values near 2 are mathematically sufficient for the quadratic families. Larger values alter smooth coloring and orbit-trap timing more than the set boundary itself.",
          lfo: "Subtle modulation changes banding and contour timing without moving the viewport.",
        },
      },
      {
        key: "paletteShift",
        label: "PALETTE PHASE",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.001,
        default: 0.12,
        format: "percent",
        info: {
          description:
            "Rotates the cosine color palette while leaving the underlying fractal calculation unchanged.",
          extremes:
            "The control wraps conceptually at 0 and 1, so both endpoints represent neighboring palette phases.",
          lfo: "This is ideal for a slow saw or sine LFO because it produces continuous color circulation.",
        },
      },
      {
        key: "colorCycles",
        label: "COLOR CYCLES",
        type: "range",
        min: 0.5,
        max: 16,
        step: 0.05,
        fineStep: 0.005,
        default: 5.2,
        format: "decimal2",
        info: {
          description:
            "Controls how many palette oscillations are packed into the normalized escape-time range.",
          extremes:
            "Low values create broad gradients. High values create narrow contour bands and can become visually busy.",
          lfo: "Slow modulation makes color bands compress and expand across the boundary.",
        },
      },
      {
        key: "orbitTrap",
        label: "ORBIT TRAP MIX",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.001,
        default: 0.42,
        format: "percent",
        info: {
          description:
            "Blends line-based and ring-based orbit traps, which measure how closely an orbit approaches selected geometric shapes.",
          extremes:
            "Near 0 favors axis-like contours. Near 1 favors circular contour glows.",
          lfo: "Moderate modulation shifts the internal contour language without changing the actual escape classification.",
        },
      },
      {
        key: "drift",
        label: "TEMPORAL DRIFT",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.001,
        default: 0,
        format: "percent",
        info: {
          description:
            "Built-in model motion that gently offsets the viewport and Julia constant over time. It starts at zero so a new model loads without motion.",
          extremes:
            "Large values can leave a delicate deep-zoom region. Use parameter LFO modulation for controlled motion.",
          lfo: "An LFO on drift changes the strength of the internal motion while the global animation clock is running.",
        },
      },
    ];
  }

  randomizeParameters(random = Math.random) {
    const equation = Math.floor(random() * EQUATIONS.length);
    const preset = choose(random, CURATED_VIEWS[equation]);
    const zoomExponent = clamp(
      Number(preset.zoomExponent) + randomBetween(random, -0.16, 0.18),
      -0.2,
      5.5,
    );
    const viewScale = 10 ** zoomExponent;
    const positionJitter =
      equation === 1 ? 0.025 : Math.min(0.025, 0.12 / Math.max(1, viewScale));
    const iterations = Math.round(
      clamp(135 + zoomExponent * 58 + randomBetween(random, 25, 160), 100, 620),
    );

    return {
      equation,
      iterations,
      zoomExponent: Number(zoomExponent.toFixed(3)),
      centerX: Number(
        (
          Number(preset.centerX) +
          randomBetween(random, -positionJitter, positionJitter)
        ).toFixed(6),
      ),
      centerY: Number(
        (
          Number(preset.centerY) +
          randomBetween(random, -positionJitter, positionJitter)
        ).toFixed(6),
      ),
      juliaReal: Number(
        (preset.juliaReal ?? randomBetween(random, -0.82, 0.42)).toFixed(5),
      ),
      juliaImag: Number(
        (preset.juliaImag ?? randomBetween(random, -0.62, 0.62)).toFixed(5),
      ),
      escapeRadius: Number(randomBetween(random, 2.4, 7.5).toFixed(2)),
      paletteShift: Number(random().toFixed(4)),
      colorCycles: Number(randomBetween(random, 2.8, 10.5).toFixed(3)),
      orbitTrap: Number(randomBetween(random, 0.12, 0.88).toFixed(4)),
      drift: 0,
    };
  }

  isInteresting(metrics) {
    if (!metrics) return false;
    return (
      Number(metrics.signalMean) > 0.025 &&
      Number(metrics.signalMean) < 0.94 &&
      Number(metrics.signalDeviation) > 0.045 &&
      Number(metrics.entropy) > 0.22 &&
      Number(metrics.edgeDensity) > 0.008 &&
      Number(metrics.complexity) > 0.18
    );
  }

  interpolateStates(stateA, stateB, mixValue) {
    const mix = clamp(Number(mixValue), 0, 1);
    const equationA = Math.round(Number(stateA?.equation ?? 0));
    const equationB = Math.round(Number(stateB?.equation ?? equationA));
    if (equationA !== equationB) {
      // Coordinate systems for different families are not directly compatible.
      // Switch complete states instead of crossing an often-empty region between them.
      return { ...(mix < 0.5 ? stateA : stateB) };
    }
    const output = {};
    this.controls.forEach((definition) => {
      const a = stateA?.[definition.key] ?? definition.default;
      const b = stateB?.[definition.key] ?? definition.default;
      if (definition.type === "select") {
        output[definition.key] = mix < 0.5 ? a : b;
      } else if (definition.key === "paletteShift") {
        output[definition.key] = circularMixUnit(a, b, mix);
      } else {
        const value = Number(a) + (Number(b) - Number(a)) * mix;
        output[definition.key] =
          definition.format === "integer" ? Math.round(value) : value;
      }
    });
    return output;
  }

  render(targetCanvas, parameters, timeSeconds = 0) {
    const started = performance.now();
    const renderParameters = parameters;
    if (this.gl) this.renderWebGl(targetCanvas, renderParameters, timeSeconds);
    else this.renderCpu(targetCanvas, renderParameters, timeSeconds);
    const equation = Math.round(clamp(renderParameters.equation, 0, 3));
    const zoom = 10 ** clamp(renderParameters.zoomExponent, -0.2, 5.5);
    const iterations = Math.round(clamp(renderParameters.iterations, 30, 700));
    return {
      backend: this.backend,
      modelMetrics: {
        equation: EQUATIONS[equation],
        iterationBudget: iterations,
        zoomScale: zoom,
        temporalDrift: Number(parameters.drift),
      },
      inferenceMs: performance.now() - started,
    };
  }

  renderWebGl(targetCanvas, parameters, timeSeconds) {
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
    gl.uniform2f(
      this.uniforms.u_center,
      Number(parameters.centerX),
      Number(parameters.centerY),
    );
    gl.uniform2f(
      this.uniforms.u_julia,
      Number(parameters.juliaReal),
      Number(parameters.juliaImag),
    );
    gl.uniform1f(
      this.uniforms.u_zoom,
      10 ** clamp(parameters.zoomExponent, -0.2, 5.5),
    );
    gl.uniform1f(this.uniforms.u_escape, clamp(parameters.escapeRadius, 2, 16));
    gl.uniform1f(this.uniforms.u_palette, clamp(parameters.paletteShift, 0, 1));
    gl.uniform1f(
      this.uniforms.u_cycles,
      clamp(parameters.colorCycles, 0.5, 16),
    );
    gl.uniform1f(this.uniforms.u_trap, clamp(parameters.orbitTrap, 0, 1));
    gl.uniform1f(this.uniforms.u_time, timeSeconds);
    gl.uniform1f(this.uniforms.u_drift, clamp(parameters.drift, 0, 1));
    gl.uniform1i(
      this.uniforms.u_equation,
      Math.round(clamp(parameters.equation, 0, 3)),
    );
    gl.uniform1i(
      this.uniforms.u_iterations,
      Math.round(clamp(parameters.iterations, 30, 700)),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
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

  renderCpu(targetCanvas, parameters, timeSeconds) {
    const renderSize = targetCanvas.width >= 1024 ? 384 : 320;
    if (
      this.cpuCanvas.width !== renderSize ||
      this.cpuCanvas.height !== renderSize
    ) {
      this.cpuCanvas.width = renderSize;
      this.cpuCanvas.height = renderSize;
    }
    const width = this.cpuCanvas.width;
    const height = this.cpuCanvas.height;
    const image = this.cpuContext.createImageData(width, height);
    const equation = Math.round(clamp(parameters.equation, 0, 3));
    const iterationLimit = Math.min(
      300,
      Math.round(clamp(parameters.iterations, 30, 700)),
    );
    const zoom = 10 ** clamp(parameters.zoomExponent, -0.2, 5.5);
    const escapeSquared = clamp(parameters.escapeRadius, 2, 16) ** 2;
    const paletteShift = clamp(parameters.paletteShift, 0, 1);
    const colorCycles = clamp(parameters.colorCycles, 0.5, 16);
    const orbitMix = clamp(parameters.orbitTrap, 0, 1);
    const driftAmount = clamp(parameters.drift, 0, 1);
    const centerX =
      Number(parameters.centerX) +
      ((Math.cos(timeSeconds * 0.23) * driftAmount) / Math.max(zoom, 1)) * 0.18;
    const centerY =
      Number(parameters.centerY) +
      ((Math.sin(timeSeconds * 0.19) * driftAmount) / Math.max(zoom, 1)) * 0.18;
    const juliaReal =
      Number(parameters.juliaReal) +
      Math.sin(timeSeconds * 0.17) * driftAmount * 0.035;
    const juliaImag =
      Number(parameters.juliaImag) +
      Math.cos(timeSeconds * 0.13) * driftAmount * 0.035;

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const aspect = width / height;
        const pointX = (((px / (width - 1)) * 2 - 1) * aspect) / zoom + centerX;
        const pointY = ((py / (height - 1)) * 2 - 1) / zoom + centerY;
        let zx = equation === 1 ? pointX : 0;
        let zy = equation === 1 ? pointY : 0;
        const cx = equation === 1 ? juliaReal : pointX;
        const cy = equation === 1 ? juliaImag : pointY;
        let escaped = -1;
        let orbit = 1000;
        let magnitudeSquared = 0;

        for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
          let sx = zx;
          let sy = zy;
          if (equation === 2) sy = -sy;
          if (equation === 3) {
            sx = Math.abs(sx);
            sy = Math.abs(sy);
          }
          const [nextX, nextY] = squareComplex(sx, sy);
          zx = nextX + cx;
          zy = nextY + cy;
          magnitudeSquared = zx * zx + zy * zy;
          const lineTrap = Math.min(Math.abs(zx), Math.abs(zy));
          const ringTrap = Math.abs(Math.sqrt(magnitudeSquared) - 0.5);
          orbit = Math.min(
            orbit,
            lineTrap * (1 - orbitMix) + ringTrap * orbitMix,
          );
          if (magnitudeSquared > escapeSquared) {
            escaped = iteration;
            break;
          }
        }

        let rgb;
        if (escaped < 0) {
          const interior = Math.exp(-orbit * (8 + colorCycles));
          const p = palette(paletteShift + interior * 0.12, paletteShift);
          rgb = p.map((value) => value * 0.22 * interior);
        } else {
          const nu =
            Math.log(Math.log(magnitudeSquared) * 0.5) / 0.6931471805599453;
          const smooth = Math.max(0, escaped + 1 - nu);
          const normalized = smooth / iterationLimit;
          const trapGlow = Math.exp(-orbit * (12 + colorCycles * 2));
          rgb = palette(
            normalized * colorCycles + paletteShift + trapGlow * 0.11,
            paletteShift,
          ).map(
            (value, channel) =>
              value * (0.28 + 0.92 * Math.pow(clamp(normalized * 3.2), 0.45)) +
              trapGlow * [0.28, 0.12, 0.42][channel],
          );
        }
        const offset = (py * width + px) * 4;
        image.data[offset] = Math.round(clamp(rgb[0]) * 255);
        image.data[offset + 1] = Math.round(clamp(rgb[1]) * 255);
        image.data[offset + 2] = Math.round(clamp(rgb[2]) * 255);
        image.data[offset + 3] = 255;
      }
    }
    this.cpuContext.putImageData(image, 0, 0);
    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
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
}
