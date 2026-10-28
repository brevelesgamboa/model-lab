import { DomeCamera } from "../render/dome-mesh.js";
import {
  createDomeGraphics,
  disposeDomeGraphics,
} from "../render/dome-graphics.js";
import { AsyncCanvasMetrics } from "../core/async-canvas-metrics.js";
import {
  DepthEstimator,
  computeDepthTexture,
  luminanceDepth,
  uploadDepthTexture,
} from "./depth-estimator.js";
import {
  FEATURE_TARGETS,
  FeatureHeatmapEstimator,
  computeFeatureHeatmap,
  emptyFeatureMap,
  uploadFeatureTexture,
} from "./inception-feature-map.js";

const range = (key, label, max, value, help, min = 0) => ({
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
    key: "featureTarget",
    label: "NEURAL FEATURE TARGET",
    type: "select",
    default: 0,
    options: FEATURE_TARGETS.map(({ layer, channel }, value) => ({
      value,
      label: `${layer} · channel ${channel}`,
    })),
    help: "Raises photo regions that activate this neuron. Changing the target maps it once; looking around reuses it.",
  },
  range(
    "depthScale",
    "DEPTH SCALE",
    1.5,
    0.6,
    "Pulls nearby regions inward using cached relative depth.",
  ),
  range(
    "neuralSwell",
    "NEURAL SWELL",
    1,
    0.35,
    "Pulls regions inward where the chosen neuron responds strongly.",
  ),
  {
    key: "waveMode",
    label: "CORTICAL WAVE MODE",
    type: "select",
    default: 2,
    options: ["Rings", "Rays", "Spiral", "Honeycomb"].map((label, value) => ({
      value,
      label,
    })),
  },
  range(
    "gain",
    "WAVE GAIN",
    1,
    0.3,
    "Height of moving log-polar waves, plus subtle color refraction.",
  ),
  range(
    "frequency",
    "WAVE FREQUENCY",
    30,
    8,
    "Spacing of rings and angular harmonics.",
    1,
  ),
  range(
    "speed",
    "WAVE SPEED",
    3,
    0.7,
    "Travel speed. Turn the clock on to animate.",
  ),
  {
    ...range(
      "eccentricity",
      "FOVEAL SCALE",
      0.5,
      0.12,
      "Log-polar compression around the center.",
      0.005,
    ),
    step: 0.005,
    fineStep: 0.001,
  },
];

export class CorticalDreamDomeModel {
  constructor() {
    this.id = "cortical-dream-dome";
    this.name = "Cortical Dream Dome (360)";
    this.family = "IMMERSIVE PHOTO / DEPTH / INCEPTION FEATURES";
    this.description =
      "Stand inside your photo. Drag to look through 360°, with depth relief, neuron-driven swells and moving cortical waves. Arrow keys also look around.";
    this.controls = CONTROLS;
    this.supportsRandomize = false;
    this.captureCapabilities = { savedRun: false };
    this.captureDisabledReason =
      "Photos, feature maps and camera views stay in this tab. Export PNG or GIF to keep the view.";
    this.technicalInfo = {
      title: this.name,
      architecture: "256² inward-facing sphere; analytic log-polar waves",
      inferenceFramework:
        "Shared Depth Anything V2 and InceptionV3 forward loaders; one-shot workers",
      inferenceBackend: "Depth: WebGPU / WASM; features: TF.js WebGL",
      browserInput:
        "Local photo; depth up to 518 pixels, Inception 299 × 299 RGB",
      browserOutput:
        "Relative depth and normalized channel activation map; radial displacement in WebGL2",
      license:
        "Depth Anything V2 Small: Apache-2.0; Inception checkpoint: see third-party notice",
      provenanceUrl: "https://distill.pub/2017/feature-visualization/",
    };
    this.camera = new DomeCamera();
    this.estimator = new DepthEstimator();
    this.featureEstimator = new FeatureHeatmapEstimator();
    this.selectedTarget = 0;
    this.sourceVersion = 0;
    this.graphicsEpoch = 0;
    this.onStateChange = () => {};
    this.metrics = new AsyncCanvasMetrics(() => this.onStateChange());
    this.source = document.createElement("canvas");
    this.canvas = document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.cancel();
      this.graphicsEpoch++;
      this.graphics = null;
      this.graphicsPromise = null;
      this.onStateChange();
    });
    this.canvas.addEventListener("webglcontextrestored", () =>
      this.onStateChange(),
    );
    this.useDemo();
  }
  get available() {
    return Boolean(this.gl) && !this.gl.isContextLost();
  }
  get backend() {
    return "WEBGL2 / 360° INDEXED DOME";
  }
  isDynamic(p) {
    return p.gain > 0 && p.speed > 0;
  }
  getCanvasMetrics(canvas, refresh) {
    return this.metrics.read(canvas, refresh);
  }
  useDemo() {
    this.cancel();
    this.source.width = 1024;
    this.source.height = 640;
    const ctx = this.source.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 1024, 640);
    gradient.addColorStop(0, "#1f274d");
    gradient.addColorStop(0.5, "#dc977c");
    gradient.addColorStop(1, "#174857");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1024, 640);
    for (let layer = 0; layer < 8; layer++) {
      ctx.beginPath();
      ctx.moveTo(0, 640);
      for (let x = 0; x <= 1024; x += 3)
        ctx.lineTo(
          x,
          170 +
            layer * 53 +
            Math.sin(x * 0.01 + layer * 1.7) * 60 +
            Math.cos(x * 0.025 - layer) * 16,
        );
      ctx.lineTo(1024, 640);
      ctx.closePath();
      ctx.fillStyle = `hsl(${195 + layer * 6} 34% ${52 - layer * 5}%)`;
      ctx.fill();
    }
    this.hasPhoto = false;
    this.sourceName = "Demo landscape";
    this.depthMap = luminanceDepth(this.source);
    this.featureMap = emptyFeatureMap();
    this.depthState = this.featureState = "demo";
    this.depthStatus = "Brightness relief";
    this.featureStatus = "Upload a photo to map a neuron";
    this.depthError = this.featureError = null;
    this.uploadSource();
    this.onStateChange();
  }
  uploadSource() {
    if (!this.graphics || !this.available) return;
    const gl = this.gl,
      g = this.graphics;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.textures[0]);
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
    uploadDepthTexture(gl, g.textures[1], this.depthMap);
    gl.activeTexture(gl.TEXTURE2);
    uploadFeatureTexture(gl, g.textures[2], this.featureMap);
  }
  async ensureGraphics() {
    if (this.graphics) return this.graphics;
    if (!this.available) throw new Error("WebGL2 is unavailable.");
    const epoch = this.graphicsEpoch;
    this.graphicsPromise ??= createDomeGraphics(
      this.gl,
      () => !this.disposed && epoch === this.graphicsEpoch && this.available,
    )
      .then((g) => {
        this.graphics = g;
        this.uploadSource();
        return g;
      })
      .catch((error) => {
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
      ctx.fillStyle = "#08080c";
      ctx.fillRect(0, 0, this.source.width, this.source.height);
      ctx.drawImage(bitmap, 0, 0, this.source.width, this.source.height);
      this.sourceName = file.name || "Local photo";
      this.hasPhoto = true;
      this.depthMap = luminanceDepth(this.source);
      this.featureMap = emptyFeatureMap();
      this.depthState = this.featureState = "pending";
      this.depthStatus = "Brightness preview";
      this.featureStatus = "Preparing neuron map…";
      this.uploadSource();
      this.onStateChange();
      await this.buildMaps();
    } finally {
      bitmap.close();
    }
  }
  async buildMaps({ depth = true, feature = true } = {}) {
    if (!this.hasPhoto || this.disposed) return;
    const version = this.sourceVersion;
    const g = await this.ensureGraphics();
    if (version !== this.sourceVersion || this.disposed) return;
    await Promise.all([
      depth ? this.estimateDepth(g, version) : null,
      feature ? this.estimateFeature(g, version) : null,
    ]);
  }
  async estimateDepth(g, version) {
    this.depthAbort?.abort();
    const abort = new AbortController();
    this.depthAbort = abort;
    this.depthState = "loading";
    this.depthError = null;
    this.depthStatus = "Estimating depth…";
    this.onStateChange();
    try {
      const result = await computeDepthTexture(this.gl, this.source, {
        texture: g.textures[1],
        estimator: this.estimator,
        signal: abort.signal,
        fallback: this.depthMap,
        onStatus: (message) => {
          if (abort.signal.aborted || version !== this.sourceVersion) return;
          this.depthStatus = message;
          this.onStateChange();
        },
      });
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      this.depthMap = result;
      this.depthState = result.kind === "estimated" ? "ready" : "fallback";
      this.depthError = result.error || null;
      this.depthStatus =
        this.depthState === "ready"
          ? `Depth ready · ${Math.round(result.inferenceMs)} ms · model released`
          : "Depth unavailable · brightness relief";
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      if (this.depthAbort === abort) this.depthAbort = null;
    }
  }
  async estimateFeature(g, version) {
    this.featureAbort?.abort();
    const abort = new AbortController();
    this.featureAbort = abort;
    const target = FEATURE_TARGETS[this.selectedTarget];
    this.featureState = "loading";
    this.featureError = null;
    this.featureMap = emptyFeatureMap();
    this.featureStatus = `Mapping ${target.layer}:${target.channel}…`;
    this.onStateChange();
    try {
      const result = await computeFeatureHeatmap(
        this.gl,
        this.source,
        target.layer,
        target.channel,
        {
          texture: g.textures[2],
          estimator: this.featureEstimator,
          signal: abort.signal,
          onStatus: (message) => {
            if (abort.signal.aborted || version !== this.sourceVersion) return;
            this.featureStatus = message;
            this.onStateChange();
          },
        },
      );
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      this.featureMap = result;
      this.featureState = result.kind === "activation" ? "ready" : "fallback";
      this.featureError = result.error || null;
      this.featureStatus =
        this.featureState === "ready"
          ? `${target.layer}:${target.channel} ready · ${result.width}×${result.height} map · model released`
          : "Neuron map unavailable · depth and waves still work";
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      if (this.featureAbort === abort) this.featureAbort = null;
    }
  }
  onParameterChange(key, value) {
    if (
      key !== "featureTarget" ||
      value === this.selectedTarget ||
      !FEATURE_TARGETS[value]
    )
      return false;
    this.selectedTarget = value;
    this.featureAbort?.abort();
    this.featureMap = emptyFeatureMap();
    if (this.graphics && this.available)
      uploadFeatureTexture(this.gl, this.graphics.textures[2], this.featureMap);
    if (this.hasPhoto)
      void this.buildMaps({ depth: false }).catch((error) => {
        if (error.name !== "AbortError") {
          this.featureError = error.message;
          this.featureState = "fallback";
          this.featureStatus = "Neuron map unavailable · try again";
          this.onStateChange();
        }
      });
    return false;
  }
  retryMaps() {
    return this.buildMaps({
      depth: this.depthState === "fallback",
      feature: this.featureState === "fallback",
    });
  }
  cancel() {
    this.sourceVersion++;
    this.depthAbort?.abort();
    this.featureAbort?.abort();
    this.depthAbort = this.featureAbort = null;
    this.estimator.cancel();
    this.featureEstimator.cancel();
    this.metrics.reset();
    if (["loading", "pending"].includes(this.depthState)) {
      this.depthState = "fallback";
      this.depthStatus = "Depth cancelled · brightness relief";
    }
    if (["loading", "pending"].includes(this.featureState)) {
      this.featureState = "fallback";
      this.featureStatus = "Neuron mapping cancelled · retry when ready";
    }
  }
  async render(target, p, timeSeconds = 0) {
    // Parameter resets/presets also reach this path, outside individual UI events.
    this.onParameterChange("featureTarget", p.featureTarget);
    const version = this.sourceVersion;
    const g = await this.ensureGraphics(),
      gl = this.gl;
    if (this.disposed || version !== this.sourceVersion || !this.available)
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
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(8 / 255, 8 / 255, 12 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(g.program);
    gl.bindVertexArray(g.vao);
    for (const [i, name] of ["source", "depth", "neural"].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[i]);
      gl.uniform1i(g.uniforms[name], i);
    }
    const camera = this.camera.matrices(target.width / target.height);
    gl.uniformMatrix4fv(g.uniforms.view, false, camera.view);
    gl.uniformMatrix4fv(g.uniforms.proj, false, camera.projection);
    gl.uniform3fv(g.uniforms.viewDir, camera.direction);
    const ratio = this.source.width / this.source.height;
    gl.uniform2f(g.uniforms.aspect, Math.min(1, ratio), Math.min(1, 1 / ratio));
    gl.uniform2f(g.uniforms.fovea, 0.5, 0.5);
    gl.uniform1i(g.uniforms.wave_mode, p.waveMode);
    for (const [name, value] of Object.entries({
      time: timeSeconds,
      frequency: p.frequency,
      speed: p.speed,
      gain: p.gain,
      depth_extrude: p.depthScale,
      neural_extrude: p.neuralSwell,
      eccentricity: p.eccentricity,
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
        depthRuns: this.estimator.runs,
        featureRuns: this.featureEstimator.runs,
        sourceName: this.sourceName,
      },
    };
  }
  dispose() {
    this.disposed = true;
    this.graphicsEpoch++;
    this.cancel();
    if (this.graphics && this.available)
      disposeDomeGraphics(this.gl, this.graphics);
    this.graphics = null;
  }
}
