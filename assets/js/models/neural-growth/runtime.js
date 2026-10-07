/*
 * SPDX-License-Identifier: Apache-2.0
 * Adapted from Google Research's Texture NCA browser implementation.
 * Changes: WebGL2 without TWGL, one checkpoint, horizontal RGBA packing,
 * deterministic sparse updates, explicit disposal and state-safe drawing.
 * See models/neural-growth/NOTICE.md and licenses/neural-growth-Apache-2.0.txt.
 */
import {
  CHANNELS,
  createSparseLayout,
  validateSeed,
  validateSize,
} from "./reference.js";

const VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PREFIX = `#version 300 es
precision highp float;
precision highp int;
uniform int u_size;
out vec4 out_color;
vec4 decodeState(vec4 value) { return (value - 127.0 / 255.0) * 4.0; }
vec4 encodeState(vec4 value) { return value / 4.0 + 127.0 / 255.0; }
ivec2 wrapCell(ivec2 p) { return (p % u_size + u_size) % u_size; }
`;

const PERCEPTION = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_shuffle;
uniform ivec2 u_offset;
uniform float u_angle;
uniform int u_topology;
const int SX[9] = int[9](-1, 0, 1, -2, 0, 2, -1, 0, 1);
const int SY[9] = int[9](-1, -2, -1, 0, 0, 0, 1, 2, 1);
const int LP[9] = int[9](1, 2, 1, 2, -12, 2, 1, 2, 1);
const float HEX_SX[6] = float[6](2.0, -2.0, 1.0, -1.0, 1.0, -1.0);
const float HEX_SY[6] = float[6](0.0, 0.0, 1.7320508, 1.7320508, -1.7320508, -1.7320508);
const float HEX_LP[6] = float[6](2.0, 2.0, 2.0, 2.0, 2.0, 2.0);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  int band = group / 3;
  int inputGroup = group % 3;
  ivec2 packed = ivec2(p.x % u_size, p.y);
  ivec2 xy = wrapCell(ivec2(round(texelFetch(u_shuffle, packed, 0).rg * 255.0)) + u_offset);
  if (band == 0) {
    out_color = texelFetch(u_state, ivec2(xy.x + inputGroup * u_size, xy.y), 0);
    return;
  }
  float cosA = cos(u_angle);
  float sinA = sin(u_angle);
  vec4 result = vec4(0.0);
  if (u_topology == 0) {
    for (int y = 0; y < 3; y++) {
      for (int x = 0; x < 3; x++) {
        ivec2 cell = wrapCell(xy + ivec2(x - 1, y - 1));
        vec4 value = vec4(round(texelFetch(u_state, ivec2(cell.x + inputGroup * u_size, cell.y), 0) * 255.0)) - 127.0;
        int k = y * 3 + x;
        float coefficient = band == 1
          ? (float(SX[k]) * cosA + float(SY[k]) * sinA)
          : (band == 2
            ? (-float(SX[k]) * sinA + float(SY[k]) * cosA)
            : float(LP[k]));
        result += value * coefficient;
      }
    }
  } else {
    int parity = xy.y % 2;
    ivec2 hexOffsets[6];
    hexOffsets[0] = ivec2(1, 0);
    hexOffsets[1] = ivec2(-1, 0);
    if (parity == 0) {
      hexOffsets[2] = ivec2(0, 1);
      hexOffsets[3] = ivec2(-1, 1);
      hexOffsets[4] = ivec2(0, -1);
      hexOffsets[5] = ivec2(-1, -1);
    } else {
      hexOffsets[2] = ivec2(1, 1);
      hexOffsets[3] = ivec2(0, 1);
      hexOffsets[4] = ivec2(1, -1);
      hexOffsets[5] = ivec2(0, -1);
    }
    for (int i = 0; i < 6; i++) {
      ivec2 cell = wrapCell(xy + hexOffsets[i]);
      vec4 value = vec4(round(texelFetch(u_state, ivec2(cell.x + inputGroup * u_size, cell.y), 0) * 255.0)) - 127.0;
      float coefficient = band == 1
        ? (HEX_SX[i] * cosA + HEX_SY[i] * sinA)
        : (band == 2
          ? (-HEX_SX[i] * sinA + HEX_SY[i] * cosA)
          : HEX_LP[i]);
      result += value * coefficient;
    }
    if (band == 3) {
      vec4 centerVal = vec4(round(texelFetch(u_state, ivec2(xy.x + inputGroup * u_size, xy.y), 0) * 255.0)) - 127.0;
      result -= centerVal * 12.0;
    }
  }
  vec4 encoded = clamp(floor((result + 1020.0) / 8.0), 0.0, 255.0);
  out_color = encoded / 255.0;
}`;

function denseShader(inputs, hiddenInput, hiddenOutput) {
  return `${PREFIX}
uniform sampler2D u_input;
uniform sampler2D u_weights;
uniform float u_scale;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 xy = ivec2(p.x % u_size, p.y);
  int outputGroup = p.x / u_size;
  vec4 result = vec4(0.0);
  for (int group = 0; group < ${inputs / 4}; group++) {
    vec4 value = texelFetch(u_input, ivec2(xy.x + group * u_size, xy.y), 0);
    value = ${hiddenInput ? "value * 2.0" : "decodeState(value)"};
    int row = group * 4;
    result += value.x * (texelFetch(u_weights, ivec2(outputGroup, row), 0) - 127.0 / 255.0);
    result += value.y * (texelFetch(u_weights, ivec2(outputGroup, row + 1), 0) - 127.0 / 255.0);
    result += value.z * (texelFetch(u_weights, ivec2(outputGroup, row + 2), 0) - 127.0 / 255.0);
    result += value.w * (texelFetch(u_weights, ivec2(outputGroup, row + 3), 0) - 127.0 / 255.0);
  }
  result += texelFetch(u_weights, ivec2(outputGroup, ${inputs}), 0) - 127.0 / 255.0;
  result *= u_scale;
  out_color = ${hiddenOutput ? "result / 2.0" : "encodeState(result)"};
}`;
}

const UPDATE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_delta;
uniform sampler2D u_inverse;
uniform ivec2 u_offset;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  vec4 previous = texelFetch(u_state, p, 0);
  vec4 inverse = texelFetch(u_inverse, wrapCell(xy - u_offset), 0);
  if (inverse.b < 0.5) { out_color = previous; return; }
  ivec2 compressed = ivec2(round(inverse.rg * 255.0));
  vec4 delta = decodeState(texelFetch(u_delta, ivec2(compressed.x + group * u_size, compressed.y), 0));
  out_color = encodeState(decodeState(previous) + delta);
}`;

const DISTURB = `${PREFIX}
uniform sampler2D u_state;
uniform ivec2 u_center;
uniform float u_radius;
uniform int u_mode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 distance = vec2(abs(ivec2(p.x % u_size, p.y) - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  if (length(distance) <= u_radius) {
    if (u_mode == 1) {
      vec2 coord = vec2(p);
      float n1 = fract(sin(dot(coord, vec2(12.9898, 78.233))) * 43758.5453);
      float n2 = fract(sin(dot(coord + vec2(17.1, 41.3), vec2(39.346, 11.135))) * 23421.631);
      float n3 = fract(sin(dot(coord + vec2(73.5, 91.2), vec2(73.156, 52.235))) * 84621.157);
      float n4 = fract(sin(dot(coord + vec2(103.7, 15.8), vec2(91.732, 29.412))) * 19283.472);
      out_color = vec4(n1, n2, n3, n4);
    } else {
      out_color = vec4(127.0 / 255.0);
    }
  } else {
    out_color = texelFetch(u_state, p, 0);
  }
}`;

const VISUALIZE = `${PREFIX}
uniform sampler2D u_state;
uniform int u_palette;
void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  vec3 rgb = clamp(decodeState(texelFetch(u_state, xy, 0)).rgb / 2.0 + 0.5, 0.0, 1.0);
  if (u_palette == 1) {
    float luminance = dot(rgb, vec3(0.299, 0.587, 0.114));
    vec3 spectrum = 0.5 + 0.5 * cos(6.283185307 * (vec3(0.0, 0.33, 0.67) + luminance * 0.85));
    rgb = spectrum * (0.35 + luminance * 0.65);
  }
  out_color = vec4(rgb, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("NCA shader compilation failed: " + error);
  }
  return shader;
}

function link(gl, source) {
  const shaders = [];
  let program;
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, VERTEX));
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, source));
    program = gl.createProgram();
    if (!program) throw new Error("Could not allocate program.");
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        "NCA shader linking failed: " + gl.getProgramInfoLog(program),
      );
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export class TextureNcaRuntime {
  constructor({ model, size = 128, seed = 1 }) {
    this.size = validateSize(size);
    this.seed = validateSeed(seed);
    if (
      !model ||
      !(model.layers?.[0]?.weights instanceof Uint8Array) ||
      !(model.layers?.[1]?.weights instanceof Uint8Array)
    ) {
      throw new Error(
        "Load a validated checkpoint before constructing the runtime.",
      );
    }
    this.model = model;
    this.steps = 0;
    this.disposed = false;
    this.lost = false;
    this.textures = [];
    this.framebuffers = [];
    this.programs = [];
    this.textureBytes = 0;
    this.lastOffset = [0, 0];
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    this.onContextLost = (event) => {
      event.preventDefault();
      this.lost = true;
    };
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!this.gl) {
      this.dispose();
      throw new Error("Neural Growth requires WebGL2.");
    }
    try {
      const gl = this.gl;
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      this.renderer = debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      this.vao = gl.createVertexArray();
      if (!this.vao) throw new Error("Could not allocate vertex array.");
      gl.bindVertexArray(this.vao);
      this.program = {};
      for (const [name, source] of Object.entries({
        perception: PERCEPTION,
        hidden: denseShader(48, false, true),
        delta: denseShader(96, true, false),
        update: UPDATE,
        disturb: DISTURB,
        visualize: VISUALIZE,
      })) {
        const handle = link(gl, source);
        this.programs.push(handle);
        this.program[name] = { handle, locations: new Map() };
      }
      this.state = this.allocate(size * 3, size, true);
      this.nextState = this.allocate(size * 3, size, true);
      this.perception = this.allocate(size * 12, size / 2, true);
      this.hidden = this.allocate(size * 24, size / 2, true);
      this.delta = this.allocate(size * 3, size / 2, true);
      this.shuffleTexture = this.allocate(size, size / 2, false);
      this.inverseTexture = this.allocate(size, size, false);
      this.weights = model.layers.map((layer) =>
        this.allocate(layer.shape[1] / 4, layer.shape[0], false, layer.weights),
      );
      this.rotation = 0;
      this.topology = "square";
      this.restart(seed);
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("WebGL initialization failed.");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  assertActive() {
    if (this.disposed) throw new Error("The NCA runtime has been disposed.");
    if (this.lost || this.gl.isContextLost())
      throw new Error(
        "The WebGL context was lost. Reload the pattern to resume.",
      );
  }

  allocate(width, height, renderTarget, data = null) {
    const gl = this.gl;
    if (Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error("The simulation exceeds this device's texture limit.");
    }
    const texture = gl.createTexture();
    if (!texture) throw new Error("Could not allocate texture.");
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    let framebuffer = null;
    if (renderTarget) {
      framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Could not allocate framebuffer.");
      this.framebuffers.push(framebuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      if (
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
      ) {
        throw new Error("NCA framebuffer is incomplete.");
      }
    }
    this.textureBytes += width * height * 4;
    return { texture, framebuffer, width, height };
  }

  run(name, output, inputs = {}, uniforms = {}) {
    const gl = this.gl;
    const program = this.program[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, output?.framebuffer ?? null);
    gl.viewport(0, 0, output?.width ?? this.size, output?.height ?? this.size);
    gl.useProgram(program.handle);
    gl.bindVertexArray(this.vao);
    const location = (key) => {
      if (!program.locations.has(key))
        program.locations.set(key, gl.getUniformLocation(program.handle, key));
      return program.locations.get(key);
    };
    gl.uniform1i(location("u_size"), this.size);
    let unit = 0;
    for (const [key, buffer] of Object.entries(inputs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.uniform1i(location(key), unit);
      unit += 1;
    }
    for (const [key, value] of Object.entries(uniforms)) {
      if (Array.isArray(value)) gl.uniform2i(location(key), value[0], value[1]);
      else if (key === "u_palette" || key === "u_topology")
        gl.uniform1i(location(key), value);
      else gl.uniform1f(location(key), value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  restart(seed = this.seed) {
    this.assertActive();
    this.seed = validateSeed(seed);
    this.layout = createSparseLayout(this.size, seed);
    this.lastOffset = [0, 0];
    const gl = this.gl;
    for (const [buffer, data] of [
      [this.shuffleTexture, this.layout.shuffle],
      [this.inverseTexture, this.layout.inverse],
    ]) {
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        buffer.width,
        buffer.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
    }
    for (const buffer of [this.state, this.nextState]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
      gl.clearColor(127 / 255, 127 / 255, 127 / 255, 127 / 255);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.steps = 0;
  }

  step(count = 1, { rotation = this.rotation, topology = this.topology } = {}) {
    this.assertActive();
    this.rotation = Number(rotation) || 0;
    this.topology = topology === "hexagonal" ? "hexagonal" : "square";
    if (!Number.isInteger(count) || count < 0 || count > 128)
      throw new RangeError("Step count must be between zero and 128.");
    for (let index = 0; index < count; index += 1) {
      this.lastOffset = [
        Math.floor(this.layout.random() * this.size),
        Math.floor(this.layout.random() * this.size),
      ];
      this.run(
        "perception",
        this.perception,
        { u_state: this.state, u_shuffle: this.shuffleTexture },
        {
          u_offset: this.lastOffset,
          u_angle: this.rotation,
          u_topology: this.topology === "hexagonal" ? 1 : 0,
        },
      );
      this.run(
        "hidden",
        this.hidden,
        { u_input: this.perception, u_weights: this.weights[0] },
        { u_scale: this.model.layers[0].scale },
      );
      this.run(
        "delta",
        this.delta,
        { u_input: this.hidden, u_weights: this.weights[1] },
        { u_scale: this.model.layers[1].scale },
      );
      this.run(
        "update",
        this.nextState,
        {
          u_state: this.state,
          u_delta: this.delta,
          u_inverse: this.inverseTexture,
        },
        { u_offset: this.lastOffset },
      );
      [this.state, this.nextState] = [this.nextState, this.state];
      this.steps += 1;
    }
  }

  disturb(x, y, radius = 8, mode = "erase") {
    this.assertActive();
    if (
      ![x, y, radius].every(Number.isFinite) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= this.size ||
      y < 0 ||
      y >= this.size ||
      radius <= 0 ||
      radius > this.size / 2
    ) {
      throw new RangeError("Disturbance must lie within the simulation grid.");
    }
    this.run(
      "disturb",
      this.nextState,
      { u_state: this.state },
      { u_center: [x, y], u_radius: radius, u_mode: mode === "noise" ? 1 : 0 },
    );
    [this.state, this.nextState] = [this.nextState, this.state];
  }

  draw(targetCanvas, palette = "native", zoom = 1) {
    this.assertActive();
    if (!["native", "spectral"].includes(palette))
      throw new Error("Unknown display palette.");
    const context = targetCanvas.getContext("2d");
    if (!context) throw new Error("A 2D display canvas is required.");
    this.run(
      "visualize",
      null,
      { u_state: this.state },
      { u_palette: palette === "spectral" ? 1 : 0 },
    );
    const extent = Math.min(targetCanvas.width, targetCanvas.height);
    context.fillStyle = "#101218";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    const z = Math.max(1, Math.min(8, Number(zoom) || 1));
    context.imageSmoothingEnabled = z === 1;
    const srcExtent = this.size / z;
    const srcOffset = (this.size - srcExtent) / 2;
    context.drawImage(
      this.canvas,
      srcOffset,
      srcOffset,
      srcExtent,
      srcExtent,
      (targetCanvas.width - extent) / 2,
      (targetCanvas.height - extent) / 2,
      extent,
      extent,
    );
  }

  readState() {
    this.assertActive();
    const gl = this.gl;
    const packed = new Uint8Array(this.state.width * this.state.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.framebuffer);
    gl.readPixels(
      0,
      0,
      this.state.width,
      this.state.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      packed,
    );
    const data = new Uint8Array(this.size * this.size * CHANNELS);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        for (let group = 0; group < 3; group += 1) {
          const source = (y * this.state.width + group * this.size + x) * 4;
          data.set(
            packed.subarray(source, source + 4),
            (y * this.size + x) * CHANNELS + group * 4,
          );
        }
      }
    }
    return data;
  }

  writeState(data) {
    this.assertActive();
    if (
      !(data instanceof Uint8Array) ||
      data.length !== this.size * this.size * CHANNELS
    ) {
      throw new Error("State must contain twelve encoded channels per cell.");
    }
    const packed = new Uint8Array(data.length);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        for (let group = 0; group < 3; group += 1) {
          const source = (y * this.size + x) * CHANNELS + group * 4;
          packed.set(
            data.subarray(source, source + 4),
            (y * this.state.width + group * this.size + x) * 4,
          );
        }
      }
    }
    const gl = this.gl;
    for (const buffer of [this.state, this.nextState]) {
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        buffer.width,
        buffer.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        packed,
      );
    }
  }

  getLastUpdateMask() {
    this.assertActive();
    const mask = new Uint8Array(this.size * this.size);
    const [dx, dy] = this.lastOffset;
    for (let index = 0; index < this.layout.shuffle.length; index += 4) {
      const x = (this.layout.shuffle[index] + dx) % this.size;
      const y = (this.layout.shuffle[index + 1] + dy) % this.size;
      mask[y * this.size + x] = 1;
    }
    return mask;
  }

  getStats() {
    return {
      steps: this.steps,
      size: this.size,
      seed: this.seed,
      backend: "WebGL2 RGBA8",
      renderer: this.renderer,
      disposed: this.disposed,
      contextLost: this.lost,
      resources: {
        textures: this.textures.length,
        framebuffers: this.framebuffers.length,
        programs: this.programs.length,
        vaos: this.vao ? 1 : 0,
        bytes: this.textureBytes,
      },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.gl) {
      for (const handle of this.textures) this.gl.deleteTexture(handle);
      for (const handle of this.framebuffers) this.gl.deleteFramebuffer(handle);
      for (const handle of this.programs) this.gl.deleteProgram(handle);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.textures.length = 0;
    this.framebuffers.length = 0;
    this.programs.length = 0;
    this.vao = null;
    this.textureBytes = 0;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
