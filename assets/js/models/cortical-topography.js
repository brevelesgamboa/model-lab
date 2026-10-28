import { OrbitCamera, createPlaneMesh } from "../render/plane-mesh.js";
import { AsyncCanvasMetrics } from "../core/async-canvas-metrics.js";
import {
  DepthEstimator,
  computeDepthTexture,
  luminanceDepth,
  uploadDepthTexture,
} from "./depth-estimator.js";

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
const range = (key, label, min, max, value, help) => ({
  key,
  label,
  type: "range",
  min,
  max,
  step: 0.01,
  default: value,
  format: "decimal2",
  help,
});
const CONTROLS = [
  {
    key: "waveMode",
    label: "WAVE MODE",
    type: "select",
    default: 2,
    options: [
      { value: 0, label: "Concentric Rings" },
      { value: 1, label: "Radiating Rays" },
      { value: 2, label: "Logarithmic Spiral" },
      { value: 3, label: "Honeycomb" },
    ],
  },
  range(
    "extrude",
    "3D EXTRUSION",
    0,
    1,
    0.35,
    "Raises the photo using cached relative depth. No inference runs when this changes.",
  ),
  range(
    "gain",
    "CORTICAL GAIN",
    0,
    1,
    0.25,
    "Height of the moving waves on the photo surface.",
  ),
  range(
    "frequency",
    "WAVE FREQUENCY",
    1,
    30,
    8,
    "Sets wave spacing. Angular harmonics use integer counts to close the polar seam.",
  ),
  range(
    "speed",
    "WAVE SPEED",
    0,
    3,
    0.7,
    "Travel speed of the analytic waves. The clock pauses them.",
  ),
  range(
    "edgeCoupling",
    "EDGE REFRACTION",
    0,
    1,
    0.35,
    "Bends photo detail along wave gradients, with subtle RGB dispersion.",
  ),
  {
    ...range(
      "eccentricity",
      "FOVEAL SCALE",
      0.005,
      0.5,
      0.12,
      "Controls compression of the log-polar mapping around the fovea.",
    ),
    step: 0.005,
    fineStep: 0.001,
  },
  range(
    "foveaX",
    "FOVEA X",
    0,
    1,
    0.5,
    "Horizontal center of the wave pattern.",
  ),
  range("foveaY", "FOVEA Y", 0, 1, 0.5, "Vertical center of the wave pattern."),
];

function compileProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram(),
    shaders = [];
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export class CorticalTopographyModel {
  constructor() {
    this.id = "cortical-topography";
    this.name = "3D Cortical Topography";
    this.family = "PHOTO HEIGHTFIELD / ANALYTIC CORTICAL WAVES";
    this.description =
      "A photo becomes a raised sheet with moving rings, rays, spirals or honeycomb waves. Drag to orbit, Shift-drag or right-drag to pan, and scroll to zoom.";
    this.controls = CONTROLS;
    this.supportsRandomize = false;
    this.captureCapabilities = { savedRun: false };
    this.captureDisabledReason =
      "Photos, depth maps and camera positions stay in this tab. Export PNG or GIF to keep the result.";
    this.technicalInfo = {
      title: this.name,
      architecture:
        "256 × 256 indexed heightfield; analytic log-polar wave patterns",
      inferenceFramework:
        "ONNX Runtime Web; one forward pass per uploaded photo, in a worker",
      inferenceBackend: "WebGPU, or worker WASM fallback",
      browserInput:
        "Local photo; aspect-preserving RGB input on a 14-pixel patch grid, up to 518 pixels",
      browserOutput: "Relative depth, then WebGL2 geometry and shading",
      license: "Depth Anything V2 Small / ONNX Community: Apache-2.0",
      provenanceUrl:
        "https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX",
    };
    this.camera = new OrbitCamera();
    this.estimator = new DepthEstimator();
    this.canvas = document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.source = document.createElement("canvas");
    this.onStateChange = () => {};
    this.metrics = new AsyncCanvasMetrics(() => this.onStateChange());
    this.sourceVersion = 0;
    this.graphicsEpoch = 0;
    this.disposed = false;
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.cancel();
      this.graphicsEpoch++;
      this.graphics = null;
      this.graphicsPromise = null;
      this.onStateChange();
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.graphics = null;
      this.graphicsPromise = null;
      this.onStateChange();
    });
    this.useDemo();
  }
  get available() {
    return Boolean(this.gl) && !this.gl.isContextLost();
  }
  get backend() {
    return "WEBGL2 / 256² INDEXED HEIGHTFIELD";
  }
  isDynamic(parameters) {
    return parameters.gain > 0 && parameters.speed > 0;
  }
  getCanvasMetrics(canvas, refresh) {
    return this.metrics.read(canvas, refresh);
  }
  useDemo() {
    this.cancel();
    this.source.width = 768;
    this.source.height = 512;
    const ctx = this.source.getContext("2d");
    const sky = ctx.createLinearGradient(0, 0, 768, 512);
    sky.addColorStop(0, "#242c51");
    sky.addColorStop(0.5, "#cc9276");
    sky.addColorStop(1, "#183f50");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 768, 512);
    for (let layer = 0; layer < 7; layer++) {
      ctx.beginPath();
      ctx.moveTo(0, 512);
      for (let x = 0; x <= 768; x += 3) {
        const y =
          155 +
          layer * 48 +
          Math.sin(x * 0.009 + layer * 1.8) * (65 - layer * 5) +
          Math.cos(x * 0.021 + layer) * 18;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(768, 512);
      ctx.closePath();
      ctx.fillStyle = `hsl(${190 + layer * 7} ${25 + layer * 3}% ${48 - layer * 5}%)`;
      ctx.fill();
    }
    this.sourceName = "Demo landscape";
    this.hasPhoto = false;
    this.depthMap = luminanceDepth(this.source);
    this.depthState = "demo";
    this.depthError = null;
    this.depthStatus =
      "Brightness relief. Choose a photo for a depth estimate.";
    this.uploadSource();
    this.onStateChange();
  }
  uploadSource() {
    if (!this.graphics || this.gl.isContextLost()) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.graphics.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.source,
    );
    gl.activeTexture(gl.TEXTURE1);
    uploadDepthTexture(gl, this.graphics.depthTexture, this.depthMap);
  }
  async ensureGraphics() {
    if (this.graphics) return this.graphics;
    if (!this.gl || this.gl.isContextLost())
      throw new Error(
        "WebGL2 is unavailable. Restore the graphics context to continue.",
      );
    const epoch = this.graphicsEpoch;
    this.graphicsPromise ??= (async () => {
      const sources = await Promise.all(
        ["cortical-3d.vert", "cortical-3d.frag", "cortical-waves.glsl"].map(
          async (name) => {
            const response = await fetch(
              new URL(`../render/${name}`, import.meta.url),
            );
            if (!response.ok) throw new Error(`Could not load ${name}.`);
            return response.text();
          },
        ),
      );
      if (
        this.disposed ||
        epoch !== this.graphicsEpoch ||
        this.gl.isContextLost()
      )
        throw new DOMException(
          "The graphics request was cancelled.",
          "AbortError",
        );
      const gl = this.gl;
      const program = compileProgram(
        gl,
        sources[0].replace("#include <cortical-waves>", sources[2]),
        sources[1].replace("#include <cortical-waves>", sources[2]),
      );
      const mesh = createPlaneMesh();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vertices = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      const indices = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
      const textures = [gl.createTexture(), gl.createTexture()];
      for (const texture of textures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      const uniforms = Object.fromEntries(
        [
          "mvp",
          "model",
          "source",
          "depth",
          "time",
          "wave_mode",
          "frequency",
          "speed",
          "gain",
          "extrude",
          "eccentricity",
          "fovea",
          "aspect",
          "viewPos",
          "lightPos",
          "edge_coupling",
        ].map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]),
      );
      this.graphics = {
        program,
        vao,
        vertices,
        indices,
        count: mesh.indices.length,
        sourceTexture: textures[0],
        depthTexture: textures[1],
        uniforms,
      };
      this.uploadSource();
      return this.graphics;
    })().catch((error) => {
      if (epoch === this.graphicsEpoch) this.graphicsPromise = null;
      throw error;
    });
    return this.graphicsPromise;
  }
  async setSourceFile(file) {
    this.cancel();
    const version = this.sourceVersion;
    const bitmap = await createImageBitmap(file);
    try {
      if (this.disposed || version !== this.sourceVersion) return;
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      this.source.width = Math.max(1, Math.round(bitmap.width * scale));
      this.source.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = this.source.getContext("2d");
      ctx.fillStyle = "#101218";
      ctx.fillRect(0, 0, this.source.width, this.source.height);
      ctx.drawImage(bitmap, 0, 0, this.source.width, this.source.height);
      this.sourceName = file.name || "Local photo";
      this.hasPhoto = true;
      this.depthMap = luminanceDepth(this.source);
      this.uploadSource();
      this.onStateChange();
      await this.estimateDepth(version);
    } finally {
      bitmap.close();
    }
  }
  async estimateDepth(version = this.sourceVersion) {
    this.cancelDepth();
    const abort = new AbortController();
    this.depthAbort = abort;
    this.depthState = "loading";
    this.depthError = null;
    this.depthStatus =
      "Preparing depth estimate… Brightness preview is available.";
    this.onStateChange();
    try {
      const graphics = await this.ensureGraphics();
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      const result = await computeDepthTexture(this.gl, this.source, {
        texture: graphics.depthTexture,
        estimator: this.estimator,
        signal: abort.signal,
        fallback: this.depthMap,
        onFallback: (result) => {
          this.depthMap = result;
          this.onStateChange();
        },
        onStatus: (message) => {
          if (!abort.signal.aborted && version === this.sourceVersion) {
            this.depthStatus = message;
            this.onStateChange();
          }
        },
      });
      if (
        abort.signal.aborted ||
        version !== this.sourceVersion ||
        this.disposed
      )
        return;
      this.depthMap = result;
      this.depthState = result.kind === "estimated" ? "ready" : "fallback";
      this.depthStatus =
        result.kind === "estimated"
          ? `Relative depth ready · ${result.backend.toUpperCase()} · ${Math.round(result.inferenceMs)} ms inference · model released`
          : "Using brightness relief. Depth estimation was unavailable; you can retry.";
      this.depthError = result.error || null;
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError" && !abort.signal.aborted) {
        this.depthError = error.message;
        this.depthState = "fallback";
        this.depthStatus =
          "Using brightness relief. Depth estimation was unavailable; you can retry.";
        this.onStateChange();
      }
    } finally {
      if (this.depthAbort === abort) this.depthAbort = null;
    }
  }
  retryDepth() {
    if (this.hasPhoto && this.depthState !== "loading")
      return this.estimateDepth();
  }
  cancelDepth() {
    this.depthAbort?.abort();
    this.depthAbort = null;
    this.estimator.cancel();
  }
  cancel() {
    this.metrics.reset();
    this.sourceVersion++;
    this.cancelDepth();
    if (this.depthState === "loading") {
      this.depthState = "fallback";
      this.depthStatus =
        "Depth estimate cancelled · brightness relief remains available.";
    }
  }
  async render(target, parameters, timeSeconds = 0) {
    const version = this.sourceVersion;
    const { gl } = this,
      g = await this.ensureGraphics();
    if (this.disposed || version !== this.sourceVersion || gl.isContextLost())
      return { backend: this.backend, status: "cancelled" };
    if (
      this.canvas.width !== target.width ||
      this.canvas.height !== target.height
    ) {
      this.canvas.width = target.width;
      this.canvas.height = target.height;
    }
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.035, 0.045, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(g.program);
    gl.bindVertexArray(g.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.sourceTexture);
    gl.uniform1i(g.uniforms.source, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.depthTexture);
    gl.uniform1i(g.uniforms.depth, 1);
    const camera = this.camera.matrices(target.width / target.height);
    gl.uniformMatrix4fv(g.uniforms.mvp, false, camera.mvp);
    gl.uniformMatrix4fv(g.uniforms.model, false, IDENTITY);
    gl.uniform3fv(g.uniforms.viewPos, camera.position);
    gl.uniform3f(g.uniforms.lightPos, -1.5, 2.5, 3);
    const ratio = this.source.width / this.source.height;
    gl.uniform2f(g.uniforms.aspect, Math.min(1, ratio), Math.min(1, 1 / ratio));
    gl.uniform2f(g.uniforms.fovea, parameters.foveaX, parameters.foveaY);
    gl.uniform1i(g.uniforms.wave_mode, parameters.waveMode);
    for (const [name, value] of Object.entries({
      time: timeSeconds,
      frequency: parameters.frequency,
      speed: parameters.speed,
      gain: parameters.gain,
      extrude: parameters.extrude,
      eccentricity: parameters.eccentricity,
      edge_coupling: parameters.edgeCoupling,
    }))
      gl.uniform1f(g.uniforms[name], value);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0);
    target
      .getContext("2d", { alpha: false })
      .drawImage(this.canvas, 0, 0, target.width, target.height);
    return {
      backend: this.backend,
      modelMetrics: {
        vertices: 65536,
        triangles: g.count / 3,
        depthKind: this.depthMap.kind,
        depthRuns: this.estimator.runs,
        sourceName: this.sourceName,
      },
    };
  }
  dispose() {
    this.disposed = true;
    this.graphicsEpoch++;
    this.cancel();
    this.estimator.dispose();
    if (this.graphics && !this.gl.isContextLost()) {
      const gl = this.gl,
        g = this.graphics;
      gl.deleteBuffer(g.vertices);
      gl.deleteBuffer(g.indices);
      gl.deleteVertexArray(g.vao);
      gl.deleteTexture(g.sourceTexture);
      gl.deleteTexture(g.depthTexture);
      gl.deleteProgram(g.program);
    }
    this.graphics = null;
  }
}
