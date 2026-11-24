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
  FeatureHeatmapEstimator,
  emptyFeatureMap,
  validateFeatureTarget,
} from "./inception-feature-map.js";

import { MiganInpainter } from "./migan-inpainter.js";
import { projectPhotoMap } from "./equirectangular-canvas.js";
import {
  DomeDreamBaker,
  bakeFullDome360,
  uploadDream360,
} from "./inception-dream-bake.js";
import { TextureNcaRuntime } from "./neural-growth/runtime.js";
import { validateCheckpoint } from "./neural-growth/reference.js";
import { PATTERNS } from "./neural-growth/patterns.js";

export const DOME_NCA_PRESETS = Object.freeze([
  {
    id: "membrane-field",
    name: "Membrane Field",
    url: new URL(
      "../../../models/neural-growth/organic-structures/membrane-field.json",
      import.meta.url,
    ),
  },
  {
    id: "filament-network",
    name: "Filament Network",
    url: new URL(
      "../../../models/neural-growth/organic-structures/filament-network.json",
      import.meta.url,
    ),
  },
  {
    id: "xeno-reef",
    name: "Xeno Reef",
    url: new URL(
      "../../../models/neural-growth/organic-structures/xeno-reef.json",
      import.meta.url,
    ),
  },
  {
    id: "mixed4c-439",
    name: "Vesicle Study",
    url: new URL(
      "../../../models/neural-growth/checkpoint.json",
      import.meta.url,
    ),
  },
]);

async function defaultLoadCheckpoint(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`Checkpoint request failed (${response.status}).`);
  return response.json();
}

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

const CONTROLS = [
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
  range(
    "ncaExtrude",
    "NCA RELIEF",
    1.5,
    0.45,
    "Dynamic biological 3D extrusion driven by live NCA cell vitality.",
    0,
  ),
  range(
    "ncaSheen",
    "BIO-SHEEN OPACITY",
    1.0,
    0.65,
    "Bioluminescent membrane sheen and vein opacity composited onto the dome.",
    0,
  ),
  range(
    "photoProtection",
    "PHOTO CORE PROTECTION",
    1.0,
    0.65,
    "Shields the core photographic portrait from biological NCA overgrowth and sheen.",
    0.0,
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

export const DOME_CONTROL_SECTIONS = Object.freeze([
  {
    id: "geometry",
    label: "Geometry & Depth",
    keys: ["depthScale", "neuralSwell", "ncaExtrude", "cameraDolly"],
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
  constructor({
    loadCheckpoint = defaultLoadCheckpoint,
    createNcaRuntime = (opts) => new TextureNcaRuntime(opts),
  } = {}) {
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
    this.inpainter = new MiganInpainter();
    this.outpaintingMode = "mirrored";
    this.inpaintState = "idle";
    this.inpaintVersion = 0;
    this.aiDepthMap = null;
    this.aiDepthAbort = null;
    this.aiDepthEstimator = new DepthEstimator();
    this.bakeState = "idle";
    this.bakeProgress = 0;
    this.bakeStatus = "Generate a 360 dream field when ready";
    this.selectedLayer = "mixed_5b";
    this.selectedChannel = 120;
    this.sourceVersion = 0;
    this.graphicsEpoch = 0;
    this._loadCheckpoint = loadCheckpoint;
    this._createNcaRuntime = createNcaRuntime;
    this.ncaPreset = "membrane-field";
    this.ncaPresetName = "Membrane Field";
    this.ncaSize = 256;
    this.ncaRuntime = null;
    this.ncaCanvas = null;
    this.ncaExtrude = 0.45;
    this.ncaSheen = 0.65;
    this.photoProtection = 0.65;
    this.ncaCheckpoints = new Map();
    this.ncaLoading = false;
    this.ncaAbort = null;
    this.ncaVitality = 0.5;
    this.ncaActivityDelta = 1.0;
    this.ncaLastSample = null;
    this.ncaFramesSinceWatchdog = 0;
    this.ncaWatchdogInterval = 30;
    this.ncaStagnationCounter = 0;
    this.ncaActiveSpores = [];
    this.ncaProbeCanvas = null;
    this.ncaProbeCtx = null;
    this.ncaFramesSinceLastBloom = 0;
    this.autonomousDrift = true;
    this.driftPhase = 0;
    this.audioBass = 0;
    this.audioActivity = 0;
    this.lastBeatTimestamp = 0;
    this.beatArmed = true;
    this.lastRenderTime = 0;
    this.currentAudioLevels = null;
    this.lastAudioTimestamp = 0;
    this.onStateChange = () => {};
    this.metrics = new AsyncCanvasMetrics(() => this.onStateChange());
    if (typeof document !== "undefined") {
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
    } else {
      this.source = null;
      this.canvas = null;
      this.gl = null;
    }
    this.initNcaPromise = this.initNca();
  }
  get available() {
    return Boolean(this.gl) && !this.gl.isContextLost();
  }
  get backend() {
    return "WEBGL2 / 360° INDEXED DOME";
  }
  get ncaPresetId() {
    return this.ncaPreset;
  }
  isDynamic(p) {
    return (
      (p.gain > 0 && p.speed > 0) ||
      (p.ncaExtrude > 0 || p.ncaSheen > 0) ||
      Boolean(this.ncaRuntime)
    );
  }
  setAutonomousDrift(enabled) {
    this.autonomousDrift = Boolean(enabled);
    if (!this.autonomousDrift && this.camera) {
      this.camera.roll = 0;
    }
  }
  updateAutonomousDrift(dt, levels = null) {
    if (!this.autonomousDrift) {
      if (this.camera && this.camera.roll) {
        this.camera.roll *= 0.85;
        if (Math.abs(this.camera.roll) < 0.0001) this.camera.roll = 0;
      }
      return;
    }
    const safeDt = Math.max(0.001, Math.min(0.1, Number(dt) || 0.016));
    this.driftPhase = (this.driftPhase || 0) + safeDt;
    const bass = levels
      ? Math.min(1, Math.max(0, Number(levels.bass) || 0))
      : (this.audioBass || 0);
    const boost = 1.0 + 0.45 * bass;

    const yawDelta = safeDt * 0.045 * boost;
    if (this.camera) {
      this.camera.look(-yawDelta / 0.006, 0);

      const pitchDelta =
        Math.cos(this.driftPhase * 0.55) * 0.006 * safeDt * boost;
      const limit = (85 * Math.PI) / 180;
      this.camera.pitch = Math.max(
        -limit,
        Math.min(limit, this.camera.pitch + pitchDelta),
      );

      this.camera.roll = Math.sin(this.driftPhase * 0.38) * 0.016 * boost;
    }
  }
  onAudioFrame(levels, timestamp, _rhythmController = null) {
    if (!levels) return false;
    this.currentAudioLevels = levels;
    const kick = Number(levels.kickOnset ?? levels.kick) || 0;
    const now = typeof timestamp === "number" ? timestamp : performance.now();
    let triggered = false;

    if (kick < 0.25) {
      this.beatArmed = true;
    }

    const elapsed = now - (this.lastBeatTimestamp || 0);
    if (this.beatArmed && kick >= 0.5 && elapsed >= 160) {
      this.lastBeatTimestamp = now;
      this.beatArmed = false;
      triggered = true;

      const s = this.ncaSize || 256;
      const kickIntensity = Math.min(1.0, Math.max(0.3, kick));
      this.injectSoftSpores({
        count: Math.random() < 0.35 ? 2 : 1,
        radius: Math.max(6, Math.round(s * (0.06 + 0.05 * kickIntensity))),
        maxStrength: 0.35 * kickIntensity,
        duration: Math.round(10 + 6 * kickIntensity),
        mode: Math.random() < 0.5 ? "kick_perturb" : "kick_color",
      });
    }

    const dt = Math.min(
      0.1,
      Math.max(0.001, (now - (this.lastAudioTimestamp || now)) / 1000),
    );
    this.lastAudioTimestamp = now;
    const alpha = Math.min(1.0, dt * 7.0);
    const targetBass = Number(levels.bass) || 0;
    const targetActivity = Number(levels.activity) || 0;
    this.audioBass =
      (this.audioBass || 0) + (targetBass - (this.audioBass || 0)) * alpha;
    this.audioActivity =
      (this.audioActivity || 0) +
      (targetActivity - (this.audioActivity || 0)) * alpha;

    return triggered;
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
    this.selectedLayer = "mixed_5b";
    this.selectedChannel = 120;
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
  async initNca(presetId = this.ncaPreset, size = this.ncaSize) {
    if (this.disposed) return;
    this.ncaLoading = true;
    this.ncaPreset = presetId;
    this.ncaSize = size;
    const domePreset = DOME_NCA_PRESETS.find((p) => p.id === presetId);
    const catalogPattern = PATTERNS.find((p) => p.id === presetId);
    this.ncaPresetName =
      domePreset?.name || catalogPattern?.name || this.ncaPresetName || presetId;
    this.ncaAbort?.abort();
    const abort = new AbortController();
    this.ncaAbort = abort;
    try {
      let checkpoint = this.ncaCheckpoints.get(presetId);
      if (!checkpoint) {
        const url =
          domePreset?.url ||
          catalogPattern?.checkpointUrl ||
          DOME_NCA_PRESETS[0].url;
        const raw = await this._loadCheckpoint(url, abort.signal);
        if (abort.signal.aborted || this.disposed) return;
        checkpoint = validateCheckpoint(raw);
        this.ncaCheckpoints.set(presetId, checkpoint);
      }
      if (abort.signal.aborted || this.disposed) return;
      if (this.ncaRuntime) {
        this.ncaRuntime.dispose();
        this.ncaRuntime = null;
      }
      this.ncaRuntime = this._createNcaRuntime({
        model: checkpoint,
        size: this.ncaSize,
        seed: 1,
      });
      this.seedNcaInitial();
      this.onStateChange();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("Failed to initialize NCA for dome:", err);
      }
    } finally {
      if (this.ncaAbort === abort) this.ncaAbort = null;
      this.ncaLoading = false;
    }
  }
  seedNcaInitial() {
    if (!this.ncaRuntime || this.ncaRuntime.disposed || this.ncaRuntime.lost)
      return;
    this.ncaRuntime.restart(1);
    const s = this.ncaSize;
    const center = Math.floor(s / 2);
    const r = Math.max(8, Math.floor(s * 0.08));
    this.ncaRuntime.disturb(center, center, r, "noise");
    this.ncaRuntime.disturb(
      Math.floor(center - s * 0.2),
      center,
      Math.floor(r * 0.7),
      "dye",
      { dyeColor: [0, 0.9, 1] },
    );
    this.ncaRuntime.disturb(
      Math.floor(center + s * 0.2),
      center,
      Math.floor(r * 0.7),
      "dye",
      { dyeColor: [1, 0.5, 0.1] },
    );
    for (let i = 0; i < 12; i++) {
      this.ncaRuntime.step(1);
    }
  }
  reseedNca() {
    this.seedNcaInitial();
    this.onStateChange();
  }
  injectSoftSpores({
    count = 2,
    radius = null,
    maxStrength = 0.32,
    duration = 12,
    mode = null,
  } = {}) {
    if (!this.ncaRuntime || this.ncaRuntime.disposed || this.ncaRuntime.lost)
      return [];
    const s = this.ncaSize;
    const rad = radius ?? Math.max(8, Math.round(s * 0.08));
    const modes = ["kick_perturb", "noise", "kick_color"];
    const created = [];
    for (let i = 0; i < count; i++) {
      const selectedMode = mode || modes[(Math.random() * modes.length) | 0];
      const x = Math.floor(s * (0.15 + Math.random() * 0.7));
      const y = Math.floor(s * (0.15 + Math.random() * 0.7));
      const spore = {
        x,
        y,
        radius: Math.max(4, Math.round(rad * (0.8 + Math.random() * 0.4))),
        maxStrength: maxStrength * (0.8 + Math.random() * 0.4),
        duration: Math.max(3, duration),
        frame: 0,
        mode: selectedMode,
      };
      this.ncaActiveSpores.push(spore);
      created.push(spore);
    }
    return created;
  }
  stepActiveSpores() {
    if (!this.ncaRuntime || this.ncaRuntime.disposed || this.ncaRuntime.lost)
      return;
    if (this.ncaActiveSpores.length === 0) return;
    for (let i = this.ncaActiveSpores.length - 1; i >= 0; i--) {
      const spore = this.ncaActiveSpores[i];
      const progress = (spore.frame + 0.5) / spore.duration;
      const strength = spore.maxStrength * Math.sin(Math.PI * progress);
      if (strength > 0.001) {
        this.ncaRuntime.disturb(spore.x, spore.y, spore.radius, spore.mode, {
          strength,
        });
      }
      spore.frame++;
      if (spore.frame >= spore.duration) {
        this.ncaActiveSpores.splice(i, 1);
      }
    }
  }
  evaluateNcaVitality(simulated = null) {
    if (!this.ncaRuntime || this.ncaRuntime.disposed || this.ncaRuntime.lost)
      return { vitality: 0, delta: 0, triggered: false };

    let vitality = 0.5;
    let delta = 1.0;

    if (simulated !== null) {
      vitality = Number(simulated.vitality ?? 0.5);
      delta = Number(simulated.delta ?? 1.0);
    } else if (
      typeof document !== "undefined" &&
      this.ncaCanvas &&
      this.ncaCanvas.width > 0
    ) {
      if (!this.ncaProbeCanvas) {
        this.ncaProbeCanvas = document.createElement("canvas");
        this.ncaProbeCanvas.width = 16;
        this.ncaProbeCanvas.height = 16;
        this.ncaProbeCtx = this.ncaProbeCanvas.getContext("2d", {
          willReadFrequently: true,
        });
      }
      if (this.ncaProbeCtx) {
        this.ncaProbeCtx.drawImage(this.ncaCanvas, 0, 0, 16, 16);
        const img = this.ncaProbeCtx.getImageData(0, 0, 16, 16);
        const data = img.data;
        let sumLum = 0;
        let diffSum = 0;
        const hasPrev = Boolean(this.ncaLastSample);

        for (let i = 0; i < 256; i++) {
          const idx = i * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          sumLum += lum;
          if (hasPrev) {
            const dr = Math.abs(r - this.ncaLastSample[idx]);
            const dg = Math.abs(g - this.ncaLastSample[idx + 1]);
            const db = Math.abs(b - this.ncaLastSample[idx + 2]);
            diffSum += (dr + dg + db) / (3 * 255);
          }
        }

        vitality = sumLum / 256;
        delta = hasPrev ? diffSum / 256 : 1.0;

        if (!this.ncaLastSample) {
          this.ncaLastSample = new Uint8Array(1024);
        }
        this.ncaLastSample.set(data);
      }
    }

    this.ncaVitality = vitality;
    this.ncaActivityDelta = delta;

    const isLowVitality = vitality < 0.10 || vitality > 0.96;
    const isStagnant = delta < 0.008;

    let triggered = false;
    if (isLowVitality || isStagnant) {
      this.ncaStagnationCounter++;
      if (this.ncaStagnationCounter >= 2 || vitality < 0.04) {
        this.injectSoftSpores({ count: 2, maxStrength: 0.35, duration: 10 });
        this.ncaStagnationCounter = 0;
        triggered = true;
      }
    } else {
      this.ncaStagnationCounter = Math.max(0, this.ncaStagnationCounter - 1);
    }

    this.ncaFramesSinceLastBloom =
      (this.ncaFramesSinceLastBloom || 0) + this.ncaWatchdogInterval;
    if (this.ncaFramesSinceLastBloom >= 800) {
      this.injectSoftSpores({ count: 1, maxStrength: 0.22, duration: 8 });
      this.ncaFramesSinceLastBloom = 0;
      triggered = true;
    }

    return { vitality, delta, triggered };
  }
  async setNcaPreset(presetId, patternData = null) {
    if (patternData?.name) {
      this.ncaPresetName = patternData.name;
    }
    if (this.ncaPreset === presetId && this.ncaRuntime) return;
    await this.initNca(presetId, this.ncaSize);
    this.injectSoftSpores({ count: 3, maxStrength: 0.35, duration: 12 });
  }
  async setNcaResolution(size) {
    const s = Number(size) === 128 ? 128 : 256;
    if (this.ncaSize === s && this.ncaRuntime) return;
    await this.initNca(this.ncaPreset, s);
  }
  uploadSource() {
    if (!this.graphics || !this.available) return;
    const gl = this.gl,
      g = this.graphics;
    gl.activeTexture(gl.TEXTURE0);
    uploadDream360(gl, g.textures[0], this.panorama);
    if (this.outpaintingMode === "mirrored")
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    if (this.ncaCanvas && g.textures[3]) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[3]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.ncaCanvas,
      );
    }
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
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
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
    ) {
      this.onStateChange();
      return;
    }
    this.selectedLayer = validated.layer;
    this.selectedChannel = validated.channel;
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
          colorRetention: 1,
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
    if (key === "photoProtection") {
      this.photoProtection = Number(value);
      return true;
    }
    if (key === "ncaExtrude") {
      this.ncaExtrude = Number(value);
      return true;
    }
    if (key === "ncaSheen") {
      this.ncaSheen = Number(value);
      return true;
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
    this.ncaAbort?.abort();
    this.ncaAbort = null;
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
    if (p.ncaExtrude !== undefined) this.ncaExtrude = p.ncaExtrude;
    if (p.ncaSheen !== undefined) this.ncaSheen = p.ncaSheen;
    if (p.photoProtection !== undefined) this.photoProtection = p.photoProtection;
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

    if (
      this.ncaRuntime &&
      !this.ncaRuntime.disposed &&
      !this.ncaRuntime.lost &&
      typeof document !== "undefined"
    ) {
      this.ncaRuntime.step(1);
      this.stepActiveSpores();

      this.ncaFramesSinceWatchdog = (this.ncaFramesSinceWatchdog || 0) + 1;
      if (this.ncaFramesSinceWatchdog >= (this.ncaWatchdogInterval || 30)) {
        this.ncaFramesSinceWatchdog = 0;
        this.evaluateNcaVitality();
      }

      if (!this.ncaCanvas) {
        this.ncaCanvas = document.createElement("canvas");
        this.ncaCanvas.width = this.ncaSize;
        this.ncaCanvas.height = this.ncaSize;
      }
      if (
        this.ncaCanvas.width !== this.ncaSize ||
        this.ncaCanvas.height !== this.ncaSize
      ) {
        this.ncaCanvas.width = this.ncaSize;
        this.ncaCanvas.height = this.ncaSize;
      }
      this.ncaRuntime.draw(this.ncaCanvas, { palette: "native" });
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[3]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.ncaCanvas,
      );
    }

    for (const [i, name] of [
      "dream_360",
      "depth",
      "neural",
      "nca_texture",
    ].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[i]);
      gl.uniform1i(g.uniforms[name], i);
    }
    const nowSec =
      typeof timeSeconds === "number" ? timeSeconds : performance.now() / 1000;
    const dt = this.lastRenderTime
      ? Math.max(0.001, Math.min(0.1, nowSec - this.lastRenderTime))
      : 0.016;
    this.lastRenderTime = nowSec;

    if (this.autonomousDrift) {
      this.updateAutonomousDrift(dt, this.currentAudioLevels);
    }

    this.camera.dolly = p.cameraDolly ?? 0.8;
    const camera = this.camera.matrices(target.width / target.height);
    gl.uniformMatrix4fv(g.uniforms.view, false, camera.view);
    gl.uniformMatrix4fv(g.uniforms.proj, false, camera.projection);
    gl.uniform3fv(g.uniforms.viewPos, camera.position);
    gl.uniform2f(g.uniforms.aspect, 1, 1);
    gl.uniform2f(g.uniforms.fovea, 0.5, 0.5);
    gl.uniform1i(g.uniforms.wave_mode, p.waveMode);
    gl.uniform1i(
      g.uniforms.mirrored_wrap,
      this.outpaintingMode === "mirrored" ? 1 : 0,
    );

    const audioBass = this.audioBass || 0;
    const audioActivity = this.audioActivity || 0;
    const effectiveGain = p.gain * (1.0 + 0.35 * audioBass);
    const effectiveSpeed = p.speed * (1.0 + 0.25 * audioActivity);
    const baseDispersion = p.chromaticDispersion ?? 0.35;
    const effectiveDispersion = Math.min(
      1.0,
      baseDispersion * (1.0 + 0.3 * audioBass + 0.2 * audioActivity),
    );

    for (const [name, value] of Object.entries({
      time: timeSeconds,
      frequency: p.frequency,
      speed: effectiveSpeed,
      gain: effectiveGain,
      depth_extrude: p.extrude ?? p.depthScale ?? 0.6,
      neural_extrude: p.neuralSwell,
      nca_extrude: p.ncaExtrude ?? this.ncaExtrude ?? 0.45,
      nca_sheen: p.ncaSheen ?? this.ncaSheen ?? 0.65,
      photo_protection: p.photoProtection ?? this.photoProtection ?? 0.65,
      eccentricity: p.eccentricity,
      edge_coupling: p.edgeCoupling ?? 0.35,
      dispersion: effectiveDispersion,
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
    if (this.ncaRuntime) {
      this.ncaRuntime.dispose();
      this.ncaRuntime = null;
    }
    this.ncaCanvas = null;
    if (this.ncaProbeCanvas) {
      this.ncaProbeCanvas = null;
      this.ncaProbeCtx = null;
    }
    this.ncaLastSample = null;
    this.ncaActiveSpores = [];
    this.currentAudioLevels = null;
    this.audioBass = 0;
    this.audioActivity = 0;
    this.driftPhase = 0;
    if (this.graphics && this.available)
      disposeDomeGraphics(this.gl, this.graphics);
    this.graphics = null;
  }
}
