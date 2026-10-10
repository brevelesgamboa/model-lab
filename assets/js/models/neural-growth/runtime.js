/*
 * SPDX-License-Identifier: Apache-2.0
 * Adapted from Google Research's Texture NCA browser implementation.
 * Changes: WebGL2 without TWGL, one checkpoint, horizontal RGBA packing,
 * deterministic sparse updates, explicit disposal and state-safe drawing.
 * See models/neural-growth/NOTICE.md and licenses/neural-growth-Apache-2.0.txt.
 */
import {
  CHANNELS,
  createInitialState,
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
uniform sampler2D u_orientation;
uniform ivec2 u_offset;
uniform float u_angle;
uniform int u_topology;
uniform int u_transform;
uniform float u_twist;
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
  float theta = u_angle;
  if (u_transform != 0) {
    vec2 center = vec2(float(u_size) * 0.5);
    vec2 pos = (vec2(xy) + 0.5 - center) / (float(u_size) * 0.5);
    float phi = atan(pos.y, pos.x);
    if (u_transform == 1) {
      theta = phi + 1.5707963 + u_twist + u_angle;
    } else if (u_transform == 2) {
      float r = max(length(pos), 0.01);
      theta = phi + 1.5707963 + log(r) * tan(u_twist) + u_angle;
    } else if (u_transform == 3) {
      vec2 z = pos * 1.25;
      vec2 c = vec2(-0.8, 0.156);
      for (int i = 0; i < 5; i++) {
        z = vec2(z.x * z.x - z.y * z.y + c.x, 2.0 * z.x * z.y + c.y);
      }
      theta = atan(z.y, z.x) + u_twist + u_angle;
    } else if (u_transform == 4) {
      vec2 p1 = pos - vec2(-0.45, 0.0);
      vec2 p2 = pos - vec2(0.45, 0.0);
      float d1 = dot(p1, p1) + 0.01;
      float d2 = dot(p2, p2) + 0.01;
      vec2 flow = vec2(-p1.y / d1 - p2.y / d2, p1.x / d1 + p2.x / d2);
      theta = atan(flow.y, flow.x) + u_twist + u_angle;
    }
  }
  vec4 orient = texelFetch(u_orientation, xy, 0);
  if (orient.b > 0.05) {
    vec2 dir = orient.rg * 2.0 - 1.0;
    float groomedAngle = atan(dir.y, dir.x);
    theta = mix(theta, groomedAngle, orient.b);
  }
  float cosA = cos(theta);
  float sinA = sin(theta);
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
uniform sampler2D u_barrier;
uniform ivec2 u_offset;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  vec4 previous = texelFetch(u_state, p, 0);
  if (texelFetch(u_barrier, xy, 0).r > 0.5) {
    out_color = previous;
    return;
  }
  vec4 inverse = texelFetch(u_inverse, wrapCell(xy - u_offset), 0);
  if (inverse.b < 0.5) { out_color = previous; return; }
  ivec2 compressed = ivec2(round(inverse.rg * 255.0));
  vec4 delta = decodeState(texelFetch(u_delta, ivec2(compressed.x + group * u_size, compressed.y), 0));
  out_color = encodeState(decodeState(previous) + delta);
}`;

const BARRIER_PASS = `${PREFIX}
uniform sampler2D u_barrier;
uniform ivec2 u_center;
uniform float u_radius;
uniform int u_barrierMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 distance = vec2(abs(p - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  float dist = length(distance);
  float current = texelFetch(u_barrier, p, 0).r;
  if (dist <= u_radius) {
    float target = u_barrierMode == 1 ? 1.0 : 0.0;
    out_color = vec4(target, 0.0, 0.0, 1.0);
  } else {
    out_color = vec4(current, 0.0, 0.0, 1.0);
  }
}`;

const ORIENTATION_PASS = `${PREFIX}
uniform sampler2D u_orientation;
uniform ivec2 u_center;
uniform float u_radius;
uniform float u_strokeAngle;
uniform int u_orientMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 distance = vec2(abs(p - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  float dist = length(distance);
  vec4 current = texelFetch(u_orientation, p, 0);
  if (dist <= u_radius) {
    float weight = smoothstep(u_radius, u_radius * 0.25, dist);
    if (u_orientMode == 1) {
      vec2 targetDir = vec2(cos(u_strokeAngle), sin(u_strokeAngle));
      vec2 existingDir = current.b > 0.05 ? (current.rg * 2.0 - 1.0) : targetDir;
      vec2 blended = normalize(mix(existingDir, targetDir, weight * 0.85));
      float newStrength = min(1.0, current.b + weight * 0.85);
      out_color = vec4(blended * 0.5 + 0.5, newStrength, 1.0);
    } else {
      out_color = mix(current, vec4(0.5, 0.5, 0.0, 0.0), weight);
    }
  } else {
    out_color = current;
  }
}
`;

const DISTURB = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform ivec2 u_center;
uniform float u_radius;
uniform int u_mode;
uniform vec3 u_dyeColor;
uniform int u_lockBarrier;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  vec2 distance = vec2(abs(xy - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  float dist = length(distance);
  if (dist <= u_radius) {
    if (u_lockBarrier == 1 && texelFetch(u_barrier, xy, 0).r > 0.5) {
      out_color = texelFetch(u_state, p, 0);
      return;
    }
    if (u_mode == 1) {
      vec2 coord = vec2(p);
      float n1 = fract(sin(dot(coord, vec2(12.9898, 78.233))) * 43758.5453);
      float n2 = fract(sin(dot(coord + vec2(17.1, 41.3), vec2(39.346, 11.135))) * 23421.631);
      float n3 = fract(sin(dot(coord + vec2(73.5, 91.2), vec2(73.156, 52.235))) * 84621.157);
      float n4 = fract(sin(dot(coord + vec2(103.7, 15.8), vec2(91.732, 29.412))) * 19283.472);
      out_color = vec4(n1, n2, n3, n4);
    } else if (u_mode == 2) {
      vec4 current = texelFetch(u_state, p, 0);
      float weight = smoothstep(u_radius, u_radius * 0.35, dist);
      if (group == 0) {
        vec4 targetState = encodeState(vec4((u_dyeColor - 0.5) * 2.0, 1.0));
        out_color = mix(current, targetState, weight);
      } else {
        out_color = current;
      }
    } else if (u_mode == 3) {
      vec4 current = texelFetch(u_state, p, 0);
      float phase = dist / max(u_radius * 0.28, 1.0);
      float wave = sin(phase * 3.1415926) * exp(-dist / max(u_radius * 0.85, 1.0));
      vec4 decoded = decodeState(current);
      decoded.rgb += wave * 0.8;
      out_color = encodeState(decoded);
    } else {
      out_color = vec4(127.0 / 255.0);
    }
  } else {
    out_color = texelFetch(u_state, p, 0);
  }
}`;

const VISUALIZE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform int u_palette;
uniform int u_shading;
uniform float u_relief;
uniform float u_lightAngle;
uniform int u_showBarrier;

float cellLuminance(ivec2 p) {
  vec3 c = decodeState(texelFetch(u_state, p, 0)).rgb / 2.0 + 0.5;
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  ivec2 xy = ivec2(gl_FragCoord.xy);
  vec3 rawRgb = decodeState(texelFetch(u_state, xy, 0)).rgb / 2.0 + 0.5;

  // Soft highlight compression: smoothly rolls off intense highlights above 0.5
  // so bright metallic models retain texture and gradients without clipping to white.
  vec3 rgb = rawRgb / (1.0 + max(vec3(0.0), rawRgb - 0.5) * 0.85);
  rgb = clamp(rgb, 0.0, 1.0);

  float lum = dot(rgb, vec3(0.299, 0.587, 0.114));

  if (u_palette == 1) {
    vec3 spectrum = 0.5 + 0.5 * cos(6.283185307 * (vec3(0.0, 0.33, 0.67) + lum * 0.85));
    rgb = spectrum * (0.35 + lum * 0.65);
  }

  if (u_shading > 0) {
    float lumLeft = cellLuminance(wrapCell(xy + ivec2(-1, 0)));
    float lumRight = cellLuminance(wrapCell(xy + ivec2(1, 0)));
    float lumDown = cellLuminance(wrapCell(xy + ivec2(0, -1)));
    float lumUp = cellLuminance(wrapCell(xy + ivec2(0, 1)));

    float dx = (lumRight - lumLeft) * u_relief;
    float dy = (lumUp - lumDown) * u_relief;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));

    if (u_shading == 3) {
      rgb = normal * 0.5 + 0.5;
    } else {
      vec3 lightDir = normalize(vec3(cos(u_lightAngle), sin(u_lightAngle), 0.85));
      float diffuse = max(dot(normal, lightDir), 0.0);
      float lighting = 0.35 + 0.65 * diffuse;
      rgb = rgb * lighting;

      if (u_shading == 2) {
        vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
        float specular = pow(max(dot(normal, halfVec), 0.0), 24.0);
        rgb = mix(rgb, vec3(1.0), specular * 0.45);
      }
    }
  }

  if (u_showBarrier == 1) {
    float bL = texelFetch(u_barrier, wrapCell(xy + ivec2(-1, 0)), 0).r;
    float bR = texelFetch(u_barrier, wrapCell(xy + ivec2(1, 0)), 0).r;
    float bD = texelFetch(u_barrier, wrapCell(xy + ivec2(0, -1)), 0).r;
    float bU = texelFetch(u_barrier, wrapCell(xy + ivec2(0, 1)), 0).r;
    float bEdge = max(abs(bR - bL), abs(bU - bD));
    if (bEdge > 0.2) {
      bool dash = mod(float(xy.x + xy.y), 8.0) < 4.0;
      if (dash) {
        rgb = mix(rgb, vec3(1.0) - rgb, 0.85);
      }
    }
  }

  out_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
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
  constructor({
    model,
    size = model?.startup?.gridSize ?? 256,
    seed = model?.startup?.seed ?? 1,
  }) {
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
        barrier: BARRIER_PASS,
        orientation: ORIENTATION_PASS,
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
      this.barrier = this.allocate(size, size, true);
      this.nextBarrier = this.allocate(size, size, true);
      this.orientation = this.allocate(size, size, true);
      this.nextOrientation = this.allocate(size, size, true);
      this.weights = model.layers.map((layer) =>
        this.allocate(layer.shape[1] / 4, layer.shape[0], false, layer.weights),
      );
      this.rotation = 0;
      this.topology = "square";
      this.coordinateTransform = "cartesian";
      this.twist = 0;
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
      if (Array.isArray(value)) {
        if (value.length === 3)
          gl.uniform3f(location(key), value[0], value[1], value[2]);
        else gl.uniform2i(location(key), value[0], value[1]);
      }
      else if (
        [
          "u_palette",
          "u_topology",
          "u_mode",
          "u_shading",
          "u_transform",
          "u_barrierMode",
          "u_orientMode",
          "u_showBarrier",
          "u_lockBarrier",
        ].includes(key)
      )
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
    for (const buffer of [
      this.barrier,
      this.nextBarrier,
      this.orientation,
      this.nextOrientation,
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.model.startup?.seedState === "noise") {
      this.writeState(createInitialState(this.size, this.seed, this.model.startup));
    } else {
      for (const buffer of [this.state, this.nextState]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
        gl.clearColor(127 / 255, 127 / 255, 127 / 255, 127 / 255);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    this.steps = 0;
  }

  step(
    count = 1,
    {
      rotation = this.rotation,
      topology = this.topology,
      coordinateTransform = this.coordinateTransform,
      twist = this.twist,
    } = {},
  ) {
    this.assertActive();
    this.rotation = Number(rotation) || 0;
    this.topology = topology === "hexagonal" ? "hexagonal" : "square";
    this.coordinateTransform = coordinateTransform || "cartesian";
    this.twist = Number(twist) || 0;
    if (!Number.isInteger(count) || count < 0 || count > 128)
      throw new RangeError("Step count must be between zero and 128.");
    const transformCode =
      this.coordinateTransform === "vortex"
        ? 1
        : this.coordinateTransform === "spiral"
          ? 2
          : this.coordinateTransform === "julia"
            ? 3
            : this.coordinateTransform === "dipole"
              ? 4
              : 0;
    for (let index = 0; index < count; index += 1) {
      this.lastOffset = [
        Math.floor(this.layout.random() * this.size),
        Math.floor(this.layout.random() * this.size),
      ];
      this.run(
        "perception",
        this.perception,
        {
          u_state: this.state,
          u_shuffle: this.shuffleTexture,
          u_orientation: this.orientation,
        },
        {
          u_offset: this.lastOffset,
          u_angle: this.rotation,
          u_topology: this.topology === "hexagonal" ? 1 : 0,
          u_transform: transformCode,
          u_twist: this.twist,
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
          u_barrier: this.barrier,
        },
        { u_offset: this.lastOffset },
      );
      [this.state, this.nextState] = [this.nextState, this.state];
      this.steps += 1;
    }
  }

  disturb(
    x,
    y,
    radius = 8,
    mode = "erase",
    { dyeColor = [0, 0.94, 1], strokeAngle = 0, lockBarrier = true } = {},
  ) {
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
    if (mode === "freeze") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 1 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      return;
    }
    if (mode === "thaw") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 0 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      return;
    }
    if (mode === "groom") {
      this.run(
        "orientation",
        this.nextOrientation,
        { u_orientation: this.orientation },
        {
          u_center: [x, y],
          u_radius: radius,
          u_strokeAngle: strokeAngle,
          u_orientMode: 1,
        },
      );
      [this.orientation, this.nextOrientation] = [
        this.nextOrientation,
        this.orientation,
      ];
      return;
    }
    if (mode === "erase") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 0 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      this.run(
        "orientation",
        this.nextOrientation,
        { u_orientation: this.orientation },
        {
          u_center: [x, y],
          u_radius: radius,
          u_strokeAngle: 0,
          u_orientMode: 0,
        },
      );
      [this.orientation, this.nextOrientation] = [
        this.nextOrientation,
        this.orientation,
      ];
    }
    const modeCode =
      mode === "noise" ? 1 : mode === "dye" ? 2 : mode === "shockwave" ? 3 : 0;
    this.run(
      "disturb",
      this.nextState,
      { u_state: this.state, u_barrier: this.barrier },
      {
        u_center: [x, y],
        u_radius: radius,
        u_mode: modeCode,
        u_dyeColor: Array.isArray(dyeColor) ? dyeColor : [0, 0.94, 1],
        u_lockBarrier: lockBarrier ? 1 : 0,
      },
    );
    [this.state, this.nextState] = [this.nextState, this.state];
  }

  clearBarrier() {
    this.assertActive();
    const gl = this.gl;
    for (const buffer of [this.barrier, this.nextBarrier]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  draw(targetCanvas, optionsOrPalette = "native", zoomArg = 1) {
    this.assertActive();
    const options =
      typeof optionsOrPalette === "object" && optionsOrPalette !== null
        ? optionsOrPalette
        : { palette: optionsOrPalette, zoom: zoomArg };

    const {
      palette = "native",
      zoom = 1,
      shading = "relief",
      reliefStrength = 1.2,
      lightAngle = 45,
      displayFilter = "smooth",
      showBarrier = false,
    } = options;

    if (!["native", "spectral"].includes(palette))
      throw new Error("Unknown display palette.");
    const context = targetCanvas.getContext("2d");
    if (!context) throw new Error("A 2D display canvas is required.");

    const shadingModes = { flat: 0, relief: 1, gloss: 2, normals: 3 };
    const shadingMode = shadingModes[shading] ?? 1;
    const lightAngleRad = (Number(lightAngle || 0) * Math.PI) / 180;
    const reliefVal = Math.max(0, Math.min(5, Number(reliefStrength) || 0));

    this.run(
      "visualize",
      null,
      { u_state: this.state, u_barrier: this.barrier },
      {
        u_palette: palette === "spectral" ? 1 : 0,
        u_shading: shadingMode,
        u_relief: reliefVal,
        u_lightAngle: lightAngleRad,
        u_showBarrier: showBarrier ? 1 : 0,
      },
    );

    const extent = Math.min(targetCanvas.width, targetCanvas.height);
    context.fillStyle = "#101218";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    const z = Math.max(1, Math.min(8, Number(zoom) || 1));
    context.imageSmoothingEnabled = displayFilter
      ? displayFilter === "smooth"
      : z === 1;
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
