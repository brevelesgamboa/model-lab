import { prepareDomeFeedback } from "../render/dome-feedback.js";
import { isLinuxFirefox } from "../render/photo-color.js";
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
import { DomeJourney } from "./dome-journey.js";
import { DomeJourneyFields } from "./dome-journey-fields.js";
import { createSeedAnchors } from "./dome-seed-cropper.js";
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
    "depthScale",
    "3D EXTRUSION",
    1.5,
    0.6,
    "Pulls nearby regions inward using cached relative depth. No inference runs when this changes.",
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
    "gain",
    "CORTICAL GAIN",
    1,
    0.25,
    "Height of the moving waves on the dome surface.",
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
  {
    ...range(
      "chromaticDispersion",
      "CHROMATIC DISPERSION",
      1,
      0.35,
      "Optical spectral dispersion along wave bends.",
      0,
    ),
    format: "percent",
  },
  range(
    "cameraDolly",
    "PARALLAX DEPTH",
    2.5,
    0.8,
    "Observer position inside the dome for true 3D perspective parallax. Scroll wheel also zooms/dollies.",
    -2.0,
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

export const DOME_CONTROL_SECTIONS = Object.freeze([
  {
    id: "geometry",
    label: "Geometry & Depth",
    keys: ["depthScale", "neuralSwell", "cameraDolly", "featureTarget"],
  },
  {
    id: "waves",
    label: "Wave Dynamics",
    keys: ["waveMode", "gain", "frequency", "speed", "eccentricity"],
  },
  {
    id: "optics",
    label: "Optics & Refraction",
    keys: ["edgeCoupling", "chromaticDispersion"],
  },
]);

export class CorticalDreamDomeModel {
  constructor() {
    this.id = "cortical-dream-dome";
    this.name = "Cortical Dream Dome (360)";
    this.family = "IMMERSIVE PHOTO / DEPTH / INCEPTION FEATURES";
    this.description =
      "Stand inside your photo. Drag to look through 360°, with depth relief, neuron-driven swells and moving cortical waves. Arrow keys also look around.";
    this.controls = CONTROLS;
    this.controlSections = DOME_CONTROL_SECTIONS;
    this.supportsRandomize = false;
    this.captureCapabilities = { savedRun: false };
    this.captureDisabledReason =
      "Photos, feature maps and camera views stay in this tab. Export PNG or GIF to keep the view.";
    this.technicalInfo = {
      title: this.name,
      overview:
        "A photo is mapped onto the interior of an inward-facing 360 sphere. Depth estimation raises foreground features in 3D relief, while analytic cortical waves travel continuously across the dome. Synthesize Dream runs InceptionV3 feature ascent in the background to hallucinate neural textures into the surrounding space while preserving the original photo.",
      architecture: "256² inward-facing sphere; analytic log-polar waves",
      inferenceFramework:
        "Depth Anything V2 & InceptionV3 feature extractors running client-side in browser workers",
      inferenceBackend: "Depth: WebGPU / WASM; features: TF.js WebGL",
      browserInput:
        "Local photo; depth up to 518 pixels, feature map 299²; Dream panorama 1024 × 512",
      browserOutput:
        "Cached equirectangular Dream texture, relative depth and channel map; radial displacement in WebGL2",
      license: "Depth Anything V2: Apache-2.0; InceptionV3: Apache-2.0",
      provenanceUrl: "https://distill.pub/2017/feature-visualization/",
      provenanceLabel: "Distill Feature Visualization Article ↗",
    };
    this.camera = new DomeCamera();
    this.estimator = new DepthEstimator();
    this.featureEstimator = new FeatureHeatmapEstimator();
    this.baker = new DomeDreamBaker();
    this.journey = new DomeJourney();
    this.journeyPalette = [0.4, 0.5, 0.6];
    this.journeyFields = new DomeJourneyFields({
      inpainter: new MiganInpainter(),
      baker: new DomeDreamBaker({ persistent: true }),
      depthEstimator: new DepthEstimator(),
      createFrontierWorkers: () => ({
        inpainter: new MiganInpainter(),
        baker: new DomeDreamBaker(),
        depthEstimator: new DepthEstimator(),
      }),
      onChange: () => this.onStateChange(),
      onCommit: () => this.uploadJourney(),
    });
    this.journey.onWarpStart = (node, warp) => {
      void this.journeyFields.generateFrontierNode(
        node.id,
        node.cell,
        this.journeyFields.anchorFor(node.cell, this.journey.seed),
        {
          seed: this.journey.seed,
          from: warp.from,
          to: warp.to,
          layer: this.selectedLayer,
          channel: this.selectedChannel,
          colorRetention: this.colorRetention,
        },
      );
    };
    this.journey.onWarpComplete = (warp) =>
      this.journeyFields.completeFrontier(warp.id);
    this.journey.onWarpCancel = () => this.journeyFields.cancelFrontier();
    this.journey.onReturnToPhoto = () => this.journeyFields.cancelFrontier();
    this.inpainter = new MiganInpainter();
    this.outpaintingMode = "mirrored";
    this.inpaintState = "idle";
    this.inpaintVersion = 0;
    this.aiDepthMap = null;
    this.aiDepthAbort = null;
    this.aiDepthEstimator = new DepthEstimator();
    this.colorRetention = 1;
    this.colorSwapRB = isLinuxFirefox();
    this.bakeState = "idle";
    this.bakeProgress = 0;
    this.bakeStatus = "Generate a 360 dream field when ready";
    this.selectedTarget = 0;
    this.selectedLayer = "mixed_5b";
    this.selectedChannel = 120;
    this._lastSeenParamFeatureTarget = null;
    this._isCustomNeuron = false;
    this.neuronArchetypes = DOME_NEURON_ARCHETYPES;
    this.dreamBridge = new LazyDomeDreamBridge({
      archetypes: DOME_NEURON_ARCHETYPES,
    });
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
      this.journeyFields.pool.releaseGPU(false);
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
  setJourneyEnabled(enabled) {
    this.journey.enabled = Boolean(enabled);
    if (enabled) this.cancelDream();
    else {
      this.journey.cancelWarp();
      this.journeyFields.cancel(false);
    }
    this.onStateChange();
  }
  resetJourney() {
    this.journey.home();
    this.journey.resetExploration();
    if (this.seedAnchors) this.journeyFields.setAnchors(this.seedAnchors);
    else this.journeyFields.reset();
  }
  newJourney(seed) {
    this.journey.newDream(seed);
    this.journeyFields.setAnchors(this.seedAnchors);
    this.camera.reset();
    this.onStateChange();
  }
  generateJourney() {
    if (["loading", "missing"].includes(this.inpaintState))
      return Promise.resolve(false);
    this.cancelDream();
    return this.journeyFields.generate(
      this.seed360,
      this.selectedLayer || "mixed_5b",
      this.selectedChannel ?? 120,
      this.colorRetention,
      {
        neuralDetail: this.journey.neuralDetail,
        regions: this.journey.generationRegions,
      },
    );
  }
  uploadJourney() {
    if (this.disposed || !this.graphics || !this.available || !this.seed360)
      return;
    const gl = this.gl,
      g = this.graphics;
    for (let index = 0; index < 5; index++) {
      gl.activeTexture(gl.TEXTURE0 + 3 + index);
      uploadDream360(
        gl,
        g.textures[3 + index],
        index === 0
          ? this.seed360
          : (this.journeyFields.regionalImage(index - 1) ?? this.seed360),
      );
      if (this.outpaintingMode === "mirrored")
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    }
    for (let index = 0; index < 4; index++) {
      const depth = this.journeyFields.regionalDepth(index);
      if (!depth) continue;
      gl.activeTexture(gl.TEXTURE0 + 8 + index);
      uploadDepthTexture(gl, g.textures[8 + index], depth);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        this.outpaintingMode === "mirrored" ? gl.CLAMP_TO_EDGE : gl.REPEAT,
      );
    }
  }
  useDemo() {
    this.cancel();
    this.seedSources = null;
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
    this.resetJourney();
    const paletteCanvas = new OffscreenCanvas(16, 8),
      paletteContext = paletteCanvas.getContext("2d");
    paletteContext.drawImage(this.source, 0, 0, 16, 8);
    const colors = paletteContext.getImageData(0, 0, 16, 8).data;
    this.journeyPalette = [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let i = channel; i < colors.length; i += 4) sum += colors[i];
      return Math.max(0.06, sum / (16 * 8 * 255));
    });
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
    this.seedAnchors = createSeedAnchors(this.seedSources || [this.source]);
    this.journeyFields.setAnchors(this.seedAnchors);
  }
  useMirrored(message = "") {
    this.resetJourney();
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
    this.resetJourney();
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
    this.uploadJourney();
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
  setSourceFile(file) {
    return this.setSourceFiles([file]);
  }
  async setSourceFiles(files) {
    const inputs = Array.from(files);
    if (inputs.length < 1 || inputs.length > 3)
      throw new RangeError("Choose between one and three seed images.");
    this.cancel();
    const version = this.sourceVersion;
    const decoded = await Promise.allSettled(
      inputs.map((file) => createImageBitmap(file)),
    );
    const bitmaps = decoded
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    try {
      if (this.disposed || version !== this.sourceVersion) return;
      const failed = decoded.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      const sources = bitmaps.map((bitmap) => {
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height)),
          canvas = new OffscreenCanvas(
            Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)),
          ),
          ctx = canvas.getContext("2d");
        ctx.fillStyle = "#08080c";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas;
      });
      this.source.width = sources[0].width;
      this.source.height = sources[0].height;
      const ctx = this.source.getContext("2d");
      ctx.drawImage(sources[0], 0, 0);
      this.seedSources = sources;
      this.sourceName = inputs
        .map((file) => file.name || "Local photo")
        .join(" + ");
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
      for (const bitmap of bitmaps) bitmap.close();
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
  setNeuronTarget(layer, channel, forceCustom = false) {
    const validated = validateFeatureTarget(layer, channel);
    const idx = FEATURE_TARGETS.findIndex(
      (t) => t.layer === validated.layer && t.channel === validated.channel,
    );
    const isCustom = forceCustom || idx < 0;
    this.selectedTarget = isCustom ? -1 : idx;
    this._isCustomNeuron = isCustom;
    this._lastSeenParamFeatureTarget = this.selectedTarget;
    if (
      this.selectedLayer === validated.layer &&
      this.selectedChannel === validated.channel &&
      this.featureState === "ready"
    ) {
      this.onStateChange();
      return;
    }
    this.selectedLayer = validated.layer;
    this.selectedChannel = validated.channel;
    this.journeyFields.cancel(false);
    if (this.journey.neuralDetail && this.journeyFields.images.length)
      this.journeyFields.status =
        "Dream Target changed · extend the space again to update optional neuron detail. Existing areas preserved.";
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
    this.journey?.cancelWarp();
    this.journeyFields?.cancel(false);
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
    const rooms = this.journeyFields.roomBindings(
      this.journey.position,
      this.journey.seed,
      gl,
    );
    const feedback = prepareDomeFeedback(gl, g, {
      width: target.width,
      height: target.height,
      active: this.journey.enabled && this.journey.geometry > 0,
      epoch: `${version}:${this.journeyFields.revision}:${this.journeyFields.textureRevision}:${this.journey.historyEpoch}:${this.journey.seed}:${this.colorSwapRB}`,
      position: [...this.journey.position],
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      time: timeSeconds,
      signature: JSON.stringify([
        p,
        timeSeconds,
        this.journey.position,
        this.camera.yaw,
        this.camera.pitch,
        this.camera.target,
        this.camera.scrollDolly,
        this.journey.enabled,
        this.journey.seed,
        this.journey.historyEpoch,
        this.journeyFields.revision,
        this.journeyFields.textureRevision,
        this.journey.recursion,
        this.journey.corruption,
        this.journey.density,
        this.journey.clarity,
        this.journey.faithfulness,
        this.journey.retro,
        this.journey.depthParallax,
        this.journey.depthFog,
        this.journey.depthContours,
        this.journey.warpUniform,
        this.colorSwapRB,
      ]),
    });
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(8 / 255, 8 / 255, 12 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(g.program);
    gl.uniform1f(g.uniforms.swap_rb, this.colorSwapRB ? 1 : 0);
    gl.uniform4fv(g.uniforms.journey_warp, this.journey.warpUniform);
    gl.uniform1i(g.uniforms.journey_room_mode, this.journey.enabled ? 1 : 0);
    gl.uniform4fv(
      g.uniforms.journey_room_cells,
      Float32Array.from(
        Array.from({ length: 4 }, (_, i) =>
          rooms[i] ? [...rooms[i].cell, 1, 0] : [0, 0, 0, 0],
        ).flat(),
      ),
    );
    gl.bindVertexArray(g.vao);
    for (const [i, name] of ["dream_360", "depth", "neural"].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[i]);
      gl.uniform1i(g.uniforms[name], i);
    }
    this.camera.dolly = p.cameraDolly ?? 0.8;
    const perspectiveCamera = this.camera.matrices(
      target.width / target.height,
    );
    const camera = this.journey.enabled
      ? this.camera.matrices(target.width / target.height, {
          originLocked: true,
        })
      : perspectiveCamera;
    for (const [index, name] of [
      "journey_anchor",
      "journey_echo",
      "journey_dream",
      "journey_structure",
      "journey_cavern",
    ].entries()) {
      gl.activeTexture(gl.TEXTURE0 + 3 + index);
      const room = rooms[index - 1];
      gl.bindTexture(
        gl.TEXTURE_2D,
        index === 0
          ? g.textures[3]
          : (room.gpu?.[0] ?? g.textures[room.photoIndex]),
      );
      gl.uniform1i(g.uniforms[name], 3 + index);
    }
    gl.uniform1i(g.uniforms.journey_enabled, this.journey.enabled ? 1 : 0);
    gl.uniform3fv(
      g.uniforms.journey_offset,
      this.journey.offset(perspectiveCamera.position),
    );
    gl.uniform4fv(g.uniforms.journey_weights, this.journey.weights);
    gl.uniform1f(g.uniforms.journey_source_weight, this.journey.sourceWeight);
    for (const [index, name] of [
      "journey_depth_echo",
      "journey_depth_dream",
      "journey_depth_structure",
      "journey_depth_cavern",
    ].entries()) {
      gl.activeTexture(gl.TEXTURE0 + 8 + index);
      gl.bindTexture(
        gl.TEXTURE_2D,
        rooms[index]?.gpu?.[1] ?? g.textures[rooms[index].depthIndex],
      );
      gl.uniform1i(g.uniforms[name], 8 + index);
    }
    gl.uniform1f(g.uniforms.journey_distance, this.journey.distance);
    gl.uniform3f(
      g.uniforms.journey_depth_effects,
      this.journey.depthParallax,
      this.journey.depthFog,
      this.journey.depthContours,
    );
    gl.uniform1f(g.uniforms.journey_geometry, this.journey.geometry);
    gl.uniform1f(g.uniforms.journey_faithfulness, this.journey.faithfulness);
    gl.uniform1f(g.uniforms.journey_retro, this.journey.retro);
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, g.textures[12]);
    gl.uniform1i(g.uniforms.journey_history, 12);
    gl.uniform2f(g.uniforms.journey_resolution, target.width, target.height);
    gl.uniform2fv(g.uniforms.journey_motion, feedback.motion);
    gl.uniform1f(g.uniforms.journey_history_valid, feedback.valid ? 1 : 0);
    gl.uniform1ui(g.uniforms.journey_seed, this.journey.seed);
    gl.uniform4f(g.uniforms.journey_style, ...this.journey.style);
    gl.uniform2f(
      g.uniforms.journey_position,
      this.journey.position[0],
      this.journey.position[1],
    );
    gl.uniform3fv(g.uniforms.journey_palette, this.journeyPalette);
    gl.uniform3fv(g.uniforms.journey_camera_offset, perspectiveCamera.position);
    gl.uniformMatrix4fv(g.uniforms.view, false, camera.view);
    gl.uniformMatrix4fv(g.uniforms.proj, false, camera.projection);
    gl.uniform3fv(g.uniforms.viewDir, camera.direction);
    gl.uniform3fv(g.uniforms.viewPos, camera.position);
    gl.uniform2f(g.uniforms.aspect, 1, 1);
    gl.uniform2f(g.uniforms.fovea, 0.5, 0.5);
    gl.uniform1i(g.uniforms.wave_mode, p.waveMode);
    gl.uniform1i(
      g.uniforms.mirrored_wrap,
      this.outpaintingMode === "mirrored" ? 1 : 0,
    );
    for (const [name, value] of Object.entries({
      color_retention: this.colorRetention ?? 1,
      time: timeSeconds,
      frequency: p.frequency,
      speed: p.speed,
      gain: p.gain,
      depth_extrude: p.extrude ?? p.depthScale ?? 0.6,
      neural_extrude: p.neuralSwell,
      eccentricity: p.eccentricity,
      edge_coupling: p.edgeCoupling ?? 0.35,
      dispersion: p.chromaticDispersion ?? 0.35,
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
        journeyDistance: this.journey.distance,
        journeySection: this.journey.section,
      },
    };
  }
  dispose() {
    this.disposed = true;
    this.graphicsEpoch++;
    this.cancel();
    this.journeyFields.reset();
    if (this.graphics && this.available)
      disposeDomeGraphics(this.gl, this.graphics);
    this.graphics = null;
  }
}
