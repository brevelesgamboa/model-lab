import { DomeCamera } from "../render/dome-mesh.js";
import {
  createDomeGraphics,
  disposeDomeGraphics,
} from "../render/dome-graphics.js";
import { AsyncCanvasMetrics } from "../core/async-canvas-metrics.js";
import {
  DepthEstimator,
  luminanceDepth,
  uploadDepthTexture,
} from "./depth-estimator.js";
import {
  FEATURE_TARGETS,
  FeatureHeatmapEstimator,
  emptyFeatureMap,
  validateFeatureTarget,
} from "./inception-feature-map.js";
import { CURATED_NEURONS } from "./neural-growth.js";
import { DreamGuidanceBridge } from "./neural-growth/dream-guidance.js";

import { MiganInpainter } from "./migan-inpainter.js";
import { projectPhotoMap } from "./equirectangular-canvas.js";
import {
  DomeDreamBaker,
  bakeFullDome360,
  uploadDream360,
} from "./inception-dream-bake.js";

const range = (key, label, max, value, help, min = 0, modulation = true) => ({
  key,
  label,
  type: "range",
  min,
  max,
  step: 0.01,
  default: value,
  format: "decimal2",
  help,
  modulation,
});
export const DOME_ARCHETYPES = Object.freeze([
  {
    id: "cellular-nodes",
    name: "Cellular & Ocular Nodes",
    layer: "mixed_5b",
    channel: 120,
    strength: 0.2,
    desc: "Eye-like centers, organic rings, and cell clusters with biological relief.",
  },
  {
    id: "ribbed-arches",
    name: "Ribbed Arches & Terraces",
    layer: "mixed_6a",
    channel: 42,
    strength: 0.2,
    desc: "Architectural ribbing, stepped terraces, and structural lattice curves.",
  },
  {
    id: "webbing-filaments",
    name: "Webbing & Micro-filaments",
    layer: "Conv2d_4a_3x3",
    channel: 42,
    strength: 0.2,
    desc: "High-frequency lace, filamentous mesh, and delicate geometric webbing.",
  },
  {
    id: "biological-lattices",
    name: "Biological Lattices",
    layer: "mixed_6d",
    channel: 182,
    strength: 0.2,
    desc: "Dense vesicular lattice networks and organic sponge-like scaffolding.",
  },
  {
    id: "crystalline-spires",
    name: "Crystalline Spires",
    layer: "mixed_7b",
    channel: 314,
    strength: 0.2,
    desc: "Faceted mineral columns, prismatic facets, and spire-like geometry.",
  },
]);

export const DOME_NEURON_ARCHETYPES = Object.freeze([
  ...DOME_ARCHETYPES,
  ...CURATED_NEURONS,
]);

export const FEATURE_TARGET_DESCRIPTIONS = Object.fromEntries(
  DOME_ARCHETYPES.map((a) => [a.layer, a.name]),
);

const CONTROLS = [
  {
    key: "featureTarget",
    label: "DREAM TARGET",
    type: "select",
    default: 0,
    options: [
      ...FEATURE_TARGETS.map(({ layer, channel }, value) => ({
        value,
        label: `${FEATURE_TARGET_DESCRIPTIONS[layer] || layer} (${layer} · #${channel})`,
      })),
      {
        value: -1,
        label: "Custom neuron target",
      },
    ],
    help: "Chooses the neuron for photo relief and the next 360 dream bake. Changing it refreshes relief once; click Synthesize Dream to bake a new field. Labels suggest motifs; individual channels do not guarantee these structures.",
  },
  range(
    "colorRetention",
    "COLOR RETENTION",
    1,
    1,
    "At 1, Dream changes brightness only and preserves the source palette. Lower values allow color changes. Applies to the next synthesis and current lighting.",
    0,
    false,
  ),
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
  range(
    "edgeCoupling",
    "EDGE REFRACTION",
    1,
    0.35,
    "Bends photo detail along wave gradients.",
  ),
  range(
    "chromaticDispersion",
    "CHROMATIC DISPERSION",
    0.01,
    0.0025,
    "Optical spectral dispersion along wave bends.",
  ),
  {
    ...range(
      "specularShininess",
      "SPECULAR SHININESS",
      64,
      32,
      "Tightness of the camera spotlight specular reflection.",
      4,
    ),
    step: 2,
    fineStep: 1,
  },
  range(
    "fogDensity",
    "VOID FOG DENSITY",
    1,
    0.35,
    "Density of darkness fading into the distance.",
  ),
];

class LazyDomeDreamBridge extends DreamGuidanceBridge {
  constructor(options) {
    super(options);
    this._previewsActive = false;
  }
  loadPreviews() {
    if (!this._previewsActive) {
      return Promise.resolve(this.previewCache);
    }
    return super.loadPreviews();
  }
  activatePreviews() {
    if (!this._previewsActive) {
      this._previewsActive = true;
      return super.loadPreviews();
    }
    return Promise.resolve(this.previewCache);
  }
  requestPreview(layer, channel, options) {
    this._previewsActive = true;
    return super.requestPreview(layer, channel, options);
  }
}

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
        "Shared depth and Inception loaders; one-shot feature maps and manual multi-step Dream ascent in workers",
      inferenceBackend: "Depth: WebGPU / WASM; features: TF.js WebGL",
      browserInput:
        "Local photo; depth up to 518 pixels, feature map 299²; Dream panorama 1024 × 512",
      browserOutput:
        "Cached equirectangular Dream texture, relative depth and channel map; radial displacement in WebGL2",
      license:
        "Depth Anything V2 Small: Apache-2.0; Inception checkpoint: see third-party notice",
      provenanceUrl: "https://distill.pub/2017/feature-visualization/",
    };
    this.camera = new DomeCamera();
    this.estimator = new DepthEstimator();
    this.featureEstimator = new FeatureHeatmapEstimator();
    this.baker = new DomeDreamBaker();
    this.inpainter = new MiganInpainter();
    this.outpaintingMode = "mirrored";
    this.inpaintState = "idle";
    this.inpaintVersion = 0;
    this.aiDepthMap = null;
    this.aiDepthAbort = null;
    this.aiDepthEstimator = new DepthEstimator();
    this.colorRetention = 1;
    this.bakeState = "idle";
    this.bakeProgress = 0;
    this.bakeStatus = "Generate a 360 dream field when ready";
    this.selectedTarget = 0;
    this.selectedLayer = "mixed_5b";
    this.selectedChannel = 120;
    this._lastSeenParamFeatureTarget = null;
    this._isCustomNeuron = false;
    this.neuronArchetypes = DOME_NEURON_ARCHETYPES;
    this.dreamBridge = new LazyDomeDreamBridge({ archetypes: DOME_NEURON_ARCHETYPES });
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
    this.prepareSurround();
    this.bakeState = "idle";
    this.bakeStatus =
      "Upload a photo, then generate the surrounding dream field";
    this.bakeMetrics = null;
    this.bakeError = null;
    this.bakeProgress = 0;
    this.selectedTarget = 0;
    this.selectedLayer = "mixed_5b";
    this.selectedChannel = 120;
    this._lastSeenParamFeatureTarget = 0;
    this._isCustomNeuron = false;
    this.uploadSource();
    this.onStateChange();
  }
  prepareSurround() {
    if (this.aiDepthAbort) {
      this.aiDepthAbort.abort();
      this.aiDepthAbort = null;
    }
    this.aiDepthEstimator?.cancel();
    this.aiDepthMap = null;
    // Instant mirror texture: the full photo, without peripheral noise.
    this.mirrorSeed = new OffscreenCanvas(1024, 512);
    this.mirrorSeed.getContext("2d").drawImage(this.source, 0, 0, 1024, 512);
    this.mirrorSeed.photoRect = null;
    this.aiSeed = null;
    this.outpaintingMode = "mirrored";
    this.seed360 = this.panorama = this.mirrorSeed;
    this.photoRect = null;
    this.inpaintState = "idle";
    this.inpaintNotice = "";
    this.inpaintInfo = null;
  }
  useMirrored(message = "") {
    this.inpaintVersion++;
    if (this.inpainter.pending) this.inpainter.cancel();
    if (this.aiDepthAbort) {
      this.aiDepthAbort.abort();
      this.aiDepthAbort = null;
    }
    this.aiDepthEstimator?.cancel();
    this.aiDepthMap = null;
    this.cancelDream();
    this.outpaintingMode = "mirrored";
    this.inpaintState = "idle";
    this.inpaintInfo = null;
    this.inpaintNotice = message;
    this.seed360 = this.panorama = this.mirrorSeed;
    this.photoRect = null;
    this.bakeState = "idle";
    this.bakeProgress = 0;
    this.bakeStatus = "Mirrored photo · synthesize when ready";
    this.uploadSource();
    this.onStateChange();
  }
  async prepareInpainting(file) {
    this.cancelDream();
    const version = ++this.inpaintVersion;
    const sourceVersion = this.sourceVersion;
    this.inpaintState = "loading";
    this.inpaintNotice = "Loading / compiling MI-GAN…";
    this.onStateChange();
    try {
      const ready = await this.inpainter.prepare(file);
      if (
        version !== this.inpaintVersion ||
        sourceVersion !== this.sourceVersion
      )
        return;
      if (ready.type === "missing") {
        this.inpaintState = "missing";
        this.inpaintNotice = "Choose the optional model or use Mirrored Wrap.";
        this.onStateChange();
        return;
      }
      this.inpaintInfo = ready;
      this.inpaintNotice = "Outpainting panorama…";
      this.onStateChange();
      const panorama =
        this.aiSeed ?? (await this.inpainter.inpaint(this.source));
      if (
        version !== this.inpaintVersion ||
        sourceVersion !== this.sourceVersion
      )
        return;
      this.cancelDream();
      if (this.aiDepthAbort) {
        this.aiDepthAbort.abort();
        this.aiDepthAbort = null;
      }
      this.aiDepthEstimator?.cancel();
      this.aiSeed = panorama;
      this.seed360 = this.panorama = panorama;
      this.photoRect = panorama.photoRect;
      this.outpaintingMode = "migan";
      this.inpaintState = "ready";
      this.inpaintNotice = "";
      this.bakeState = "idle";
      this.bakeProgress = 0;
      this.bakeStatus = "AI panorama ready";
      this.aiDepthMap = luminanceDepth(panorama);
      this.uploadSource();
      this.onStateChange();
      void this.estimateAiPanoramaDepth(panorama, version);
    } catch (error) {
      if (version === this.inpaintVersion && error.name !== "AbortError") {
        this.inpainter.cancel();
        this.useMirrored(
          `MI-GAN unavailable · ${error.message} · Mirrored Wrap active`,
        );
      }
    }
  }
  async estimateAiPanoramaDepth(panorama, version) {
    if (this.aiDepthAbort) this.aiDepthAbort.abort();
    const abort = new AbortController();
    this.aiDepthAbort = abort;
    try {
      const result = await this.aiDepthEstimator.estimate(panorama, {
        signal: abort.signal,
      });
      if (
        abort.signal.aborted ||
        version !== this.inpaintVersion ||
        this.outpaintingMode !== "migan"
      ) {
        return;
      }
      this.aiDepthMap = {
        depth: result.depth,
        width: result.width,
        height: result.height,
        kind: "estimated",
      };
      this.uploadGeometry();
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError" && !abort.signal.aborted) {
        // Luminance depth relief remains active fallback
      }
    } finally {
      if (this.aiDepthAbort === abort) this.aiDepthAbort = null;
    }
  }
  uploadSource() {
    if (!this.graphics || !this.available) return;
    const gl = this.gl,
      g = this.graphics;
    gl.activeTexture(gl.TEXTURE0);
    uploadDream360(gl, g.textures[0], this.panorama);
    if (this.outpaintingMode === "mirrored")
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    this.uploadGeometry();
  }
  uploadGeometry() {
    if (!this.graphics || !this.available) return;
    const gl = this.gl,
      g = this.graphics;
    const project = (values, width, height) =>
      this.outpaintingMode === "mirrored"
        ? { depth: values, width, height }
        : projectPhotoMap(
            values,
            width,
            height,
            this.photoRect,
            this.panorama.width,
            this.panorama.height,
          );
    gl.activeTexture(gl.TEXTURE1);
    if (this.outpaintingMode === "migan" && this.aiDepthMap) {
      uploadDepthTexture(gl, g.textures[1], this.aiDepthMap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    } else {
      uploadDepthTexture(
        gl,
        g.textures[1],
        project(this.depthMap.depth, this.depthMap.width, this.depthMap.height),
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        this.outpaintingMode === "mirrored" ? gl.CLAMP_TO_EDGE : gl.REPEAT,
      );
    }
    gl.activeTexture(gl.TEXTURE2);
    uploadDepthTexture(
      gl,
      g.textures[2],
      project(
        this.featureMap.values,
        this.featureMap.width,
        this.featureMap.height,
      ),
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      this.outpaintingMode === "mirrored" ? gl.CLAMP_TO_EDGE : gl.REPEAT,
    );
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
      this.prepareSurround();
      this.bakeState = "idle";
      this.bakeStatus =
        "Photo preserved in front · generate the surrounding dream field when ready";
      this.bakeMetrics = null;
      this.bakeError = null;
      this.bakeProgress = 0;
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
  async estimateDepth(_g, version) {
    this.depthAbort?.abort();
    const abort = new AbortController();
    this.depthAbort = abort;
    this.depthState = "loading";
    this.depthError = null;
    this.depthStatus = "Estimating depth…";
    this.onStateChange();
    try {
      const result = await this.estimator.estimate(this.source, {
        signal: abort.signal,
        onStatus: (message) => {
          if (!abort.signal.aborted && version === this.sourceVersion) {
            this.depthStatus = message;
            this.onStateChange();
          }
        },
      });
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      this.depthMap = { ...result, kind: "estimated" };
      this.depthState = "ready";
      this.depthStatus = `Depth ready · ${Math.round(result.inferenceMs)} ms · model released`;
      this.uploadGeometry();
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError" && !abort.signal.aborted) {
        this.depthState = "fallback";
        this.depthError = error.message;
        this.depthStatus = "Depth unavailable · brightness relief";
        this.onStateChange();
      }
    } finally {
      if (this.depthAbort === abort) this.depthAbort = null;
    }
  }
  setNeuronTarget(layer, channel) {
    const validated = validateFeatureTarget(layer, channel);
    if (
      this.selectedLayer === validated.layer &&
      this.selectedChannel === validated.channel &&
      this.featureState === "ready"
    )
      return;
    this.selectedLayer = validated.layer;
    this.selectedChannel = validated.channel;
    const idx = FEATURE_TARGETS.findIndex(
      (t) => t.layer === validated.layer && t.channel === validated.channel,
    );
    this.selectedTarget = idx >= 0 ? idx : -1;
    this._isCustomNeuron = idx < 0;
    this._lastSeenParamFeatureTarget = this.selectedTarget;
    this.cancelDream();
    this.featureAbort?.abort();
    this.featureMap = emptyFeatureMap();
    this.uploadGeometry();
    if (this.hasPhoto)
      void this.buildMaps({ depth: false }).catch((error) => {
        if (error.name !== "AbortError") {
          this.featureError = error.message;
          this.featureState = "fallback";
          this.featureStatus = "Neuron map unavailable · try again";
          this.onStateChange();
        }
      });
    this.onStateChange();
  }
  async estimateFeature(_g, version) {
    this.featureAbort?.abort();
    const abort = new AbortController();
    this.featureAbort = abort;
    const layer = this.selectedLayer || "mixed_5b";
    const channel = Number.isInteger(this.selectedChannel)
      ? this.selectedChannel
      : 120;
    this.featureState = "loading";
    this.featureError = null;
    this.featureMap = emptyFeatureMap();
    this.featureStatus = `Mapping ${layer}:${channel}…`;
    this.uploadGeometry();
    this.onStateChange();
    try {
      const result = await this.featureEstimator.estimate(
        this.source,
        layer,
        channel,
        {
          signal: abort.signal,
          onStatus: (message) => {
            if (!abort.signal.aborted && version === this.sourceVersion) {
              this.featureStatus = message;
              this.onStateChange();
            }
          },
        },
      );
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      this.featureMap = result;
      this.featureState = "ready";
      this.featureStatus = `${layer}:${channel} ready · ${result.width}×${result.height} map · model released`;
      this.uploadGeometry();
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError" && !abort.signal.aborted) {
        this.featureMap = emptyFeatureMap();
        this.featureState = "fallback";
        this.featureError = error.message;
        this.featureStatus =
          "Neuron map unavailable · depth and waves still work";
        this.uploadGeometry();
        this.onStateChange();
      }
    } finally {
      if (this.featureAbort === abort) this.featureAbort = null;
    }
  }
  async generateDream(iterations = 15) {
    if (
      !this.hasPhoto ||
      this.bakeState === "baking" ||
      this.outpaintingMode === "migan" ||
      ["loading", "missing"].includes(this.inpaintState)
    )
      return;
    const version = this.sourceVersion,
      layer = this.selectedLayer || "mixed_5b",
      channel = Number.isInteger(this.selectedChannel)
        ? this.selectedChannel
        : 120;
    const abort = new AbortController();
    this.bakeAbort = abort;
    this.bakeState = "baking";
    this.bakeProgress = 0;
    this.bakeError = null;
    this.bakeStatus = "Synthesizing 360 Universe: 0%…";
    this.onStateChange();
    try {
      const g = await this.ensureGraphics();
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      const result = await bakeFullDome360(
        this.gl,
        this.seed360,
        layer,
        channel,
        iterations,
        (percent, message) => {
          if (abort.signal.aborted || version !== this.sourceVersion) return;
          this.bakeProgress = percent;
          this.bakeStatus =
            message || `Synthesizing 360 Universe: ${percent}%…`;
          this.onStateChange();
        },
        {
          baker: this.baker,
          texture: g.textures[0],
          signal: abort.signal,
          colorRetention: this.colorRetention,
        },
      );
      if (abort.signal.aborted || version !== this.sourceVersion) return;
      this.panorama = result.canvas;
      this.uploadSource();
      const { canvas: _canvas, texture: _texture, ...stats } = result;
      this.bakeMetrics = stats;
      this.bakeState = "ready";
      this.bakeStatus = `360 dream ready · ${result.iterations} steps · ${(result.bakeMs / 1000).toFixed(1)} s synthesis`;
      this.onStateChange();
    } catch (error) {
      if (error.name !== "AbortError" && !abort.signal.aborted) {
        this.bakeState = "error";
        this.bakeError = error.message;
        this.bakeStatus =
          "Dream bake unavailable · your previous view is preserved";
        this.onStateChange();
      }
    } finally {
      if (this.bakeAbort === abort) this.bakeAbort = null;
    }
  }
  cancelDream() {
    this.bakeAbort?.abort();
    this.bakeAbort = null;
    this.baker.cancel();
    if (this.bakeState === "baking") {
      this.bakeState = "cancelled";
      this.bakeStatus = "Dream bake cancelled · previous view preserved";
      this.onStateChange();
    }
  }
  onParameterChange(key, value) {
    if (key === "colorRetention" && Number.isFinite(value)) {
      if (value !== this.colorRetention) this.cancelDream();
      this.colorRetention = Math.max(0, Math.min(1, value));
      return false;
    }
    if (key === "featureTarget" && Number.isInteger(value)) {
      if (value === -1) {
        this._isCustomNeuron = true;
        this._lastSeenParamFeatureTarget = -1;
        this.selectedTarget = -1;
        return false;
      }
      if (FEATURE_TARGETS[value]) {
        this._isCustomNeuron = false;
        this._lastSeenParamFeatureTarget = value;
        if (value !== this.selectedTarget) {
          const target = FEATURE_TARGETS[value];
          this.setNeuronTarget(target.layer, target.channel);
        }
        return false;
      }
    }
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
    this.inpaintVersion++;
    this.inpainter.cancel();
    if (this.aiDepthAbort) {
      this.aiDepthAbort.abort();
      this.aiDepthAbort = null;
    }
    this.aiDepthEstimator?.cancel();
    if (["loading", "missing"].includes(this.inpaintState)) {
      this.inpaintState = "idle";
      this.inpaintNotice = "Inpainting cancelled · previous view preserved";
    }
    this.cancelDream();
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
    // Parameter resets/presets reach this path outside individual UI events.
    if (
      p.featureTarget !== undefined &&
      p.featureTarget !== this._lastSeenParamFeatureTarget
    ) {
      this._lastSeenParamFeatureTarget = p.featureTarget;
      if (p.featureTarget >= 0 && FEATURE_TARGETS[p.featureTarget]) {
        this._isCustomNeuron = false;
        this.onParameterChange("featureTarget", p.featureTarget);
      } else if (p.featureTarget === -1) {
        this._isCustomNeuron = true;
      }
    }
    this.onParameterChange("colorRetention", p.colorRetention ?? 1);
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
    for (const [i, name] of ["dream_360", "depth", "neural"].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[i]);
      gl.uniform1i(g.uniforms[name], i);
    }
    const camera = this.camera.matrices(target.width / target.height);
    gl.uniformMatrix4fv(g.uniforms.view, false, camera.view);
    gl.uniformMatrix4fv(g.uniforms.proj, false, camera.projection);
    gl.uniform3fv(g.uniforms.viewDir, camera.direction);
    gl.uniform2f(g.uniforms.aspect, 1, 1);
    gl.uniform2f(g.uniforms.fovea, 0.5, 0.5);
    gl.uniform1i(g.uniforms.wave_mode, p.waveMode);
    gl.uniform1i(
      g.uniforms.mirrored_wrap,
      this.outpaintingMode === "mirrored" ? 1 : 0,
    );
    for (const [name, value] of Object.entries({
      color_retention: this.colorRetention,
      time: timeSeconds,
      frequency: p.frequency,
      speed: p.speed,
      gain: p.gain,
      depth_extrude: p.depthScale,
      neural_extrude: p.neuralSwell,
      eccentricity: p.eccentricity,
      edge_coupling: p.edgeCoupling ?? 0.35,
      dispersion: p.chromaticDispersion ?? 0.0025,
      shininess: p.specularShininess ?? 32,
      fog_density: p.fogDensity ?? 0.35,
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
        dreamBakes: this.baker.runs,
        dreamState: this.bakeState,
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
