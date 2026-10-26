import { sanitizeParameters } from "../core/model-contract.js";
import { hexToRgb } from "../core/utils.js";
import { detectCapabilities } from "../core/quality.js";
import { validateCheckpoint } from "./neural-growth/reference.js";
import { TextureNcaRuntime } from "./neural-growth/runtime.js";
import {
  DEFAULT_PATTERN,
  PATTERNS,
  getPattern,
} from "./neural-growth/patterns.js";
import { AUDIO_PROFILES } from "./neural-growth/audio-profiles.js";
import {
  ResonanceConfig,
  RESONANCE_PRESETS,
} from "./neural-growth/resonance-config.js";
import {
  AcousticEmitter,
  ACOUSTIC_INJECTION_MODES,
  ACOUSTIC_POSITION_MODES,
} from "./neural-growth/acoustic-emitter.js";
import {
  CameraMotionEngine,
  CAMERA_BREATHING_MODES,
} from "./neural-growth/camera-motion.js";
import { DreamGuidanceBridge } from "./neural-growth/dream-guidance.js";

async function loadCheckpoint(signal, pattern) {
  const response = await fetch(pattern.checkpointUrl, { signal });
  if (!response.ok)
    throw new Error(`Checkpoint request failed (${response.status}).`);
  return response.json();
}

function tileState(oldData, oldSize, newSize) {
  const CHANNELS = 12;
  const newData = new Uint8Array(newSize * newSize * CHANNELS);
  for (let y = 0; y < newSize; y += 1) {
    const srcY = y % oldSize;
    const destRow = y * newSize * CHANNELS;
    const srcRow = srcY * oldSize * CHANNELS;
    for (let x = 0; x < newSize; x += 1) {
      const srcX = x % oldSize;
      const srcOffset = srcRow + srcX * CHANNELS;
      const destOffset = destRow + x * CHANNELS;
      for (let c = 0; c < CHANNELS; c += 1) {
        newData[destOffset + c] = oldData[srcOffset + c];
      }
    }
  }
  return newData;
}

// App-owned clock, persistent GPU state. A redraw is never a simulation update.
export class NeuralGrowthModel {
  constructor({
    load = loadCheckpoint,
    createRuntime = (options) => new TextureNcaRuntime(options),
    capabilities = detectCapabilities(),
    getInceptionModel = null,
  } = {}) {
    this.id = "neural-growth";
    this.name = "Neural Growth";
    this.family = "TEXTURE NEURAL CELLULAR AUTOMATON";
    this.backend = "WEBGL2 NCA";
    this.description =
      "Learned local update rules grow original organic textures or a published reference across a persistent cellular grid. Choose a pattern and disturb the field to observe regeneration.";
    this.available = true;
    this.supportsModulation = true;
    this.supportsRandomize = false;
    this.statefulSimulation = true;
    this.captureCapabilities = {
      png: true,
      gif: false,
      highResolution: true,
      savedRun: true,
    };
    this._load = load;
    this._createRuntime = createRuntime;
    this._checkpoints = new Map();
    this._activePattern = null;
    this._requestedPattern = DEFAULT_PATTERN;
    this._loadingPattern = false;
    this._runtime = null;
    this._needsRuntime = false;
    this._pending = null;
    this._abort = null;
    this._epoch = 0;
    this._disposed = false;
    this._clockRunning = false;
    this._lastTick = null;
    this._accumulator = 0;
    this._queuedDisturbances = [];
    this._lastKickInputTime = 0;
    this._kickInputBudget = 0;
    this._kickInputIndex = 0;
    this._palettePhaseAccumulator = 0.0;
    this._lastPaletteTime = null;
    this._acousticEmitter = null;
    this._cameraMotion = new CameraMotionEngine();
    this._dreamBridge = new DreamGuidanceBridge({ getInceptionModel });
    this._dreamStepCounter = 0;
    this._effectiveZoom = 1.0;
    this._effectivePan = [0.0, 0.0];
    this._capabilities = capabilities;
    this._parameters = sanitizeParameters(this);
    this.lastError = null;
    this._failedConfiguration = null;
  }

  get dreamBridge() {
    return this._dreamBridge;
  }

  get effectiveZoom() {
    return this._effectiveZoom;
  }

  get effectivePan() {
    return this._effectivePan;
  }

  get cameraMotion() {
    return this._cameraMotion;
  }

  _simulationSizeOptions() {
    const maxTex = this._capabilities?.maxTextureSize ?? 0;
    const options = [
      {
        value: 128,
        label: "128 × 128 · lighter",
        compute: "efficient",
        guidance: "Ultra-fast frame rate, suitable for low-power devices.",
      },
      {
        value: 256,
        label: "256 × 256 · more detail",
        compute: "neutral",
        guidance: "Standard balanced resolution for desktop GPUs.",
      },
    ];
    if (maxTex >= 12288) {
      options.push({
        value: 512,
        label: "512 × 512 · Ultra HD",
        compute: "demanding",
        guidance: "262,144 neural cells. High-density grid for dedicated GPUs.",
      });
    }
    if (maxTex >= 16384) {
      options.push({
        value: 1024,
        label: "1024 × 1024 · 1M Cells",
        compute: "demanding",
        guidance: "1,048,576 neural cells. Maximum resolution simulation grid.",
      });
    }
    return options;
  }

  get controls() {
    return [
      {
        key: "pattern",
        label: "PATTERN",
        type: "select",
        default: DEFAULT_PATTERN,
        options: PATTERNS.map(({ id, name, pack }) => ({
          value: id,
          label: `${pack} · ${name}`,
        })),
        help: "Changing pattern loads its checkpoint and restarts once. Failed loads retain the current field; use Restart to retry.",
        getGuidance: (value) => {
          const pattern = PATTERNS.find((entry) => entry.id === value);
          if (!pattern) return null;
          const category = pattern.category;
          if (category === "inception") {
            return {
              compute: "balanced",
              tag: "inception",
              text: "Deep feature activation. Excels with cellular Voronoi, kaleidoscopic petals, and subtle resonance.",
            };
          }
          if (category === "organic") {
            return {
              compute: "balanced",
              tag: "organic",
              text: "Quantization-trained organic structure. High self-repair stability under vortex and hyperbolic fields.",
            };
          }
          if (category === "texture") {
            return {
              compute: "balanced",
              tag: "vgg texture",
              text: "Pretrained VGG Gram texture. Responds smoothly to Voronoi islands, wave ribbons, and spiral geometry.",
            };
          }
          return {
            compute: "neutral",
            tag: "experimental",
            text: "Experimental checkpoint. Ideal for exploring perturbation resilience and boundary shear dynamics.",
          };
        },
      },
      {
        key: "seed",
        label: "SEED",
        type: "number",
        min: 0,
        max: 4294967295,
        step: 1,
        default: 1,
        help: "Changing the seed restarts the grid and its deterministic update schedule.",
      },
      {
        key: "growthSpeed",
        label: "GROWTH SPEED",
        type: "range",
        min: 0,
        max: 120,
        step: 1,
        default: 30,
        help: "Requested updates per second, limited to two per frame. Zero freezes growth; CLOCK pauses without resetting.",
        getGuidance: (value) => {
          const speed = Number(value) || 0;
          if (speed === 0) {
            return {
              compute: "neutral",
              tag: "paused",
              text: "Zero speed freezes growth; cells retain their current state.",
            };
          }
          if (speed <= 45) {
            return {
              compute: "balanced",
              tag: "recommended",
              text: "Recommended (30). Natural organic growth rate and stable pattern dynamics.",
            };
          }
          if (speed <= 80) {
            return {
              compute: "light",
              tag: "active",
              text: "Fast growth. Rapid cellular evolution and dynamic wave propagation.",
            };
          }
          return {
            compute: "moderate",
            tag: "rapid",
            text: "Accelerated update rate. Fast visual transitions.",
          };
        },
      },
      {
        key: "simulationSize",
        label: "SIMULATION GRID",
        type: "select",
        default: 256,
        options: this._simulationSizeOptions(),
        help: "Changing grid size restarts the simulation. Viewport resolution does not change the grid.",
      },
      {
        key: "rotation",
        label: "ROTATION",
        type: "range",
        min: 0,
        max: 360,
        step: 1,
        default: 0,
        wrap: true,
        help: "Rotates directional perception filters in real time without resetting or losing field state.",
      },
      {
        key: "coordinateTransform",
        label: "COORDINATE GEOMETRY",
        type: "select",
        default: "cartesian",
        options: [
          {
            value: "cartesian",
            label: "Cartesian · Standard 2D",
            compute: "neutral",
            tag: "recommended",
            guidance: "Recommended. Standard 2D grid with stable pattern equilibrium.",
          },
          {
            value: "spiral",
            label: "Spiral · Logarithmic Swirl",
            compute: "balanced",
            tag: "swirl",
            guidance: "Logarithmic swirl. Best with subtle pitch (±15° to ±35°) for fluid rotation.",
          },
          {
            value: "vortex",
            label: "Vortex · Concentric Ring",
            compute: "balanced",
            tag: "orbital",
            guidance: "Concentric circular warp. Keeps cells revolving in smooth rings.",
          },
          {
            value: "wave",
            label: "Wave · Flowing Ribbons",
            compute: "balanced",
            tag: "undulating",
            guidance: "Sinusoidal vector field. Shapes cells into smoothly bending ribbons and flowing bands.",
          },
          {
            value: "saddle",
            label: "Saddle · Branching Streams",
            compute: "moderate",
            tag: "hyperbolic",
            guidance: "Hyperbolic vector field with pinched center, crossing streams, and 4-way branching arms.",
          },
          {
            value: "kaleidoscope",
            label: "Kaleidoscope · Radial Symmetry",
            compute: "balanced",
            tag: "petals",
            guidance: "N-fold radial reflection symmetry. Creates petal-like floral mandalas and radial structures.",
          },
          {
            value: "vortex_pair",
            label: "Vortex Pair · Dual Swirl",
            compute: "moderate",
            tag: "twin poles",
            guidance: "Dual vortex field. Pitch controls same vs opposite spin and strength ratio; Softness controls spacing.",
          },
          {
            value: "voronoi",
            label: "Cellular · Voronoi Islands",
            compute: "moderate",
            tag: "islands",
            guidance: "Multi-center cellular field. Twist shifts between circulating island whirlpools, dense nodules, and boundary stream networks.",
          },
          {
            value: "julia",
            label: "Julia · Complex Fractal",
            compute: "moderate",
            tag: "fractal",
            guidance: "Complex fractal coordinates. Creates dendritic fractal branches.",
          },
          {
            value: "dipole",
            label: "Dipole · Binary Vortex",
            compute: "moderate",
            tag: "bipolar",
            guidance: "Dual vortex field with opposing poles generating swirling cellular streams.",
          },
        ],
        help: "Transforms local perception vector fields: concentric rings, logarithmic spirals, sinusoidal waves, hyperbolic saddles, kaleidoscopic petals, dual vortices, or Voronoi cellular islands.",
      },
      {
        key: "twist",
        label: "SPIRAL PITCH / TWIST",
        type: "range",
        min: -90,
        max: 90,
        step: 1,
        default: 0,
        format: "degrees",
        help: "Pitch and angular twist in degrees for spiral and vortex geometries. Modulates inward/outward swirl.",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          if (transform === "cartesian") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Twist has no effect in Cartesian geometry. Switch to Spiral or Vortex.",
            };
          }
          if (transform === "wave") {
            const t = Math.abs(Number(value) || 0);
            if (t <= 5) {
              return {
                compute: "neutral",
                tag: "horizontal",
                text: "Parallel undulating bands with pure sinusoidal curvature.",
              };
            }
            return {
              compute: "gentle",
              tag: "skewed wave",
              text: "Diagonal wave propagation with sheared ribbon curvature.",
            };
          }
          if (transform === "saddle") {
            const t = Math.abs(Number(value) || 0);
            if (t <= 5) {
              return {
                compute: "neutral",
                tag: "orthogonal",
                text: "Orthogonal hyperbolic axes with 4 symmetrical branching arms.",
              };
            }
            return {
              compute: "moderate",
              tag: "spiral saddle",
              text: "Rotated hyperbolic arms with asymmetrical spiral shear.",
            };
          }
          if (transform === "kaleidoscope") {
            const folds = Math.min(12, Math.max(3, Math.round(6 + (Number(value) || 0) / 22.5)));
            return {
              compute: "balanced",
              tag: `${folds}-fold petals`,
              text: `${folds}-fold radial reflection symmetry. Modulates flower petal count.`,
            };
          }
          if (transform === "vortex_pair") {
            const v = Number(value) || 0;
            if (v < -5) {
              return {
                compute: "moderate",
                tag: "counter-spin",
                text: "Opposite spin (counter-rotating). Drives a central jet stream between poles.",
              };
            }
            if (v > 5) {
              return {
                compute: "moderate",
                tag: "co-rotating",
                text: "Same spin (co-rotating) with asymmetric strength ratio.",
              };
            }
            return {
              compute: "neutral",
              tag: "balanced pair",
              text: "Balanced twin vortices with equal co-rotating strengths.",
            };
          }
          if (transform === "voronoi") {
            const v = Number(value) || 0;
            if (v > 10) {
              return {
                compute: "moderate",
                tag: "island nodules",
                text: "Inward-converging flow forming dense, isolated cellular nodules.",
              };
            }
            if (v < -10) {
              return {
                compute: "moderate",
                tag: "capillary maze",
                text: "Flow directed along cell boundaries into an interconnected capillary network.",
              };
            }
            return {
              compute: "balanced",
              tag: "cellular eddies",
              text: "Balanced cellular whirlpools circulating inside organic island cells.",
            };
          }
          const t = Math.abs(Number(value) || 0);
          if (t <= 10) {
            return {
              compute: "neutral",
              tag: "gentle",
              text: "Subtle angular pitch. Preserves natural texture alignment.",
            };
          }
          if (t <= 45) {
            return {
              compute: "balanced",
              tag: "recommended",
              text: "Recommended (±15° to ±35° for spirals). Fluid rotational drift without shearing.",
            };
          }
          if (t <= 65) {
            return {
              compute: "moderate",
              tag: "vivid",
              text: "Pronounced swirl with strong rotational momentum.",
            };
          }
          return {
            compute: "high",
            tag: "high shear",
            text: "High angular shear near limits. May distort fine texture features.",
          };
        },
      },
      {
        key: "geometryStrength",
        label: "GEOMETRY STRENGTH",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        default: 1.0,
        format: "percent",
        help: "Blends between standard Cartesian baseline (0%) and curvilinear transform (100%).",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          if (transform === "cartesian") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Geometry strength has no effect in Cartesian geometry.",
            };
          }
          const v = Number(value) || 0;
          if (v <= 0.05) {
            return {
              compute: "neutral",
              tag: "subtle",
              text: "Cartesian baseline. Texture maintains standard grid equilibrium.",
            };
          }
          if (v <= 0.45) {
            return {
              compute: "gentle",
              tag: "balanced",
              text: "Gentle directional bias. Safe for delicate and high-frequency textures.",
            };
          }
          if (v <= 0.85) {
            return {
              compute: "balanced",
              tag: "orbital",
              text: "Rich curvilinear swirl while preserving structural pattern fidelity.",
            };
          }
          return {
            compute: "moderate",
            tag: "full warp",
            text: "Full curvilinear transformation. Dominant rotational field.",
          };
        },
      },
      {
        key: "geometryCenterX",
        label: "CENTER X",
        type: "range",
        min: -1,
        max: 1,
        step: 0.02,
        default: 0,
        help: "Horizontal offset of the geometry focal center (-1 = left, +1 = right).",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          if (transform === "cartesian") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Center offset has no effect in Cartesian geometry.",
            };
          }
          const v = Number(value) || 0;
          if (Math.abs(v) <= 0.05) {
            return {
              compute: "neutral",
              tag: "centered",
              text: "Focal center aligned at horizontal midpoint.",
            };
          }
          return {
            compute: "gentle",
            tag: v < 0 ? "left" : "right",
            text: `Offset ${Math.round(v * 100)}% from center.`,
          };
        },
      },
      {
        key: "geometryCenterY",
        label: "CENTER Y",
        type: "range",
        min: -1,
        max: 1,
        step: 0.02,
        default: 0,
        help: "Vertical offset of the geometry focal center (-1 = bottom, +1 = top).",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          if (transform === "cartesian") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Center offset has no effect in Cartesian geometry.",
            };
          }
          const v = Number(value) || 0;
          if (Math.abs(v) <= 0.05) {
            return {
              compute: "neutral",
              tag: "centered",
              text: "Focal center aligned at vertical midpoint.",
            };
          }
          return {
            compute: "gentle",
            tag: v < 0 ? "bottom" : "top",
            text: `Offset ${Math.round(v * 100)}% from center.`,
          };
        },
      },
      {
        key: "geometrySoftness",
        label: "FIELD SOFTNESS",
        type: "range",
        min: 0,
        max: 1,
        step: 0.02,
        default: 0.25,
        format: "percent",
        help: "Regularizes the center singularity and feathers edge falloff to prevent pattern tearing.",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          if (transform === "cartesian") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Field softness has no effect in Cartesian geometry.",
            };
          }
          if (transform === "voronoi") {
            const v = Number(value) || 0;
            if (v <= 0.2) {
              return {
                compute: "balanced",
                tag: "macro islands",
                text: "Broad macro islands with bold, distinct growth territories.",
              };
            }
            if (v <= 0.6) {
              return {
                compute: "balanced",
                tag: "organic cells",
                text: "Balanced cellular scale with organic, regularized boundary walls.",
              };
            }
            return {
              compute: "gentle",
              tag: "micro cells",
              text: "Fine micro-cellular clusters with feathered boundary corridors.",
            };
          }
          if (transform === "vortex_pair") {
            const v = Number(value) || 0;
            if (v <= 0.2) {
              return {
                compute: "moderate",
                tag: "tight poles",
                text: "Closely spaced vortex cores creating a concentrated dipole interaction.",
              };
            }
            if (v <= 0.6) {
              return {
                compute: "balanced",
                tag: "split pair",
                text: "Balanced separation with distinct twin circulation zones.",
              };
            }
            return {
              compute: "gentle",
              tag: "wide poles",
              text: "Wide pole separation spanning across canvas edges.",
            };
          }
          const v = Number(value) || 0;
          if (v <= 0.05) {
            return {
              compute: "moderate",
              tag: "sharp",
              text: "Sharp singularity. May cause center shearing on sensitive textures.",
            };
          }
          if (v <= 0.45) {
            return {
              compute: "neutral",
              tag: "regularized",
              text: "Smooth regularized core. Prevents center pinch while maintaining rotation.",
            };
          }
          return {
            compute: "gentle",
            tag: "feathered",
            text: "Feathered edge falloff. Smoothly transitions into undisturbed borders.",
          };
        },
      },
      {
        key: "foldCount",
        label: "KALEIDOSCOPE FOLDS",
        type: "range",
        min: 3,
        max: 12,
        step: 1,
        default: 6,
        format: "integer",
        modulation: false,
        help: "Number of rotational symmetry sectors (petals) when Coordinate Geometry is set to Kaleidoscope.",
        getGuidance: (value, allParams) => {
          const transform =
            allParams?.coordinateTransform ??
            this._parameters?.coordinateTransform ??
            "cartesian";
          const n = Math.round(Number(value) || 6);
          if (transform !== "kaleidoscope") {
            return {
              compute: "neutral",
              tag: "inactive",
              text: "Fold count is active when Coordinate Geometry is set to Kaleidoscope.",
            };
          }
          return {
            compute: "neutral",
            tag: `${n}-fold`,
            text: `${n} symmetrical reflection sectors across the coordinate circle.`,
          };
        },
      },
      {
        key: "resonanceMode",
        label: "RESONANCE MODE",
        type: "select",
        default: "off",
        options: [
          {
            value: "off",
            label: "Off · Baseline",
            compute: "neutral",
            tag: "baseline",
            guidance: "Standard inference loop without perturbation.",
          },
          {
            value: "subtle",
            label: "Subtle · Organic Drift",
            compute: "balanced",
            tag: "drift",
            guidance: "Gentle phase drift, light cell-state memory, and micro-noise to breathe organic life into patterns.",
          },
          {
            value: "full",
            label: "Full · Dynamic Resonance",
            compute: "moderate",
            tag: "resonance",
            guidance: "Dynamic phase drift, rich temporal momentum, harmonic activation warping, and bounded mutation.",
          },
          {
            value: "custom",
            label: "Custom · User Defined",
            compute: "moderate",
            tag: "custom",
            guidance: "User-defined dynamic drift, cell-state feedback, noise, and warp parameters.",
          },
        ],
        help: "Non-linear resonance and perturbation modes modulating perception, cell-state feedback, noise, and activation warping.",
      },
      {
        key: "resonanceDrift",
        label: "PERCEPTION DRIFT",
        type: "range",
        min: -0.1,
        max: 0.1,
        step: 0.005,
        default: 0.0,
        help: "Dynamic angular drift rate injected into perception filter kernels across spatial gradients.",
      },
      {
        key: "resonanceFeedback",
        label: "STATE FEEDBACK",
        type: "range",
        min: 0.0,
        max: 0.8,
        step: 0.02,
        default: 0.0,
        help: "Temporal momentum and blending weight applied to non-RGB hidden channels (channels 4-11).",
      },
      {
        key: "resonanceNoise",
        label: "STOCHASTIC NOISE",
        type: "range",
        min: 0.0,
        max: 0.3,
        step: 0.005,
        default: 0.0,
        help: "Bounded pseudo-random perturbation strength targeted strictly at hidden channels to test resilience.",
      },
      {
        key: "resonanceWarp",
        label: "ACTIVATION WARP",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.02,
        default: 0.0,
        help: "Periodic harmonic sine blend in update activations to alter symmetry and palette convergence.",
      },
      {
        key: "latentMomentum",
        label: "STATE MOMENTUM",
        type: "range",
        min: 0.0,
        max: 0.9,
        step: 0.05,
        default: 0.0,
        modulation: false,
        help: "Temporal inertia and viscous damping on hidden channels 4..11.",
        getGuidance: (value) => {
          const m = Number(value) || 0;
          if (m <= 0.001) {
            return {
              compute: "neutral",
              tag: "instant",
              text: "Zero state inertia. Instantaneous discrete cellular transitions.",
            };
          }
          if (m <= 0.4) {
            return {
              compute: "balanced",
              tag: "moderate",
              text: "Fluid cell-state momentum. Imparts trailing temporal persistence and stabilizes motifs.",
            };
          }
          return {
            compute: "gentle",
            tag: "heavy",
            text: "Heavy viscous inertia. Hidden channels resist rapid changes, producing persistent fluid waves.",
          };
        },
      },
      {
        key: "audioProfile",
        label: "AUDIO REACT",
        type: "select",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "subtle", label: "Subtle" },
          { value: "continuous", label: "Continuous" },
          { value: "dynamic", label: "Dynamic" },
          { value: "custom", label: "Custom" },
        ],
        help: "Audio-reactive presets configuring base parameters, modulation routes, and LFOs. Fully editable in parameter MOD panels.",
      },
      {
        key: "beatShockwave",
        label: "BEAT SHOCKWAVE",
        type: "select",
        default: "on",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ],
        help: "Audio kick-driven optical water ripple on accepted beats.",
      },
      {
        key: "shockwaveIntensity",
        label: "SHOCKWAVE INTENSITY",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.05,
        default: 0.30,
        help: "Optical refraction depth for kick beat shockwaves.",
      },
      {
        key: "acousticInjection",
        label: "AUDIO COUPLING",
        type: "select",
        default: "off",
        options: [
          {
            value: "off",
            label: "Off",
            guidance: "Audio coupling disabled. Visualizer acts as display overlay.",
          },
          {
            value: "dye",
            label: "Dye (Color)",
            guidance: "Frequencies inject soft watercolor pigments (cyan bass, emerald mids, magenta treble).",
          },
          {
            value: "shockwave",
            label: "Ripple",
            guidance: "Transients emit expanding physical wavefronts that ripple through the cellular texture.",
          },
          {
            value: "sprout",
            label: "Sprout (Growth)",
            guidance: "Transients awaken dormant cells and gently sprout fresh growth branches.",
          },
          {
            value: "flow",
            label: "Flow",
            guidance: "Frequency energy pushes directional currents into cell hidden channels.",
          },
        ],
        help: "Audio wave injects frequency-mapped physical disturbances directly into the cellular automata grid.",
      },
      {
        key: "acousticThreshold",
        label: "AUDIO SENSITIVITY",
        type: "range",
        min: 0.20,
        max: 0.80,
        step: 0.05,
        default: 0.45,
        modulatable: true,
        help: "Audio transient onset sensitivity required to trigger an injection.",
      },
      {
        key: "acousticPosition",
        label: "AUDIO ORIGIN",
        type: "select",
        default: "curve_peaks",
        options: [
          {
            value: "curve_peaks",
            label: "Wave Peaks",
            guidance: "Injections originate directly from the dynamic crests of the waveform.",
          },
          {
            value: "baseline",
            label: "Center Line",
            guidance: "Injections originate along the horizontal center line.",
          },
          {
            value: "center",
            label: "Focal Center",
            guidance: "Injections radiate outward from the active focal center.",
          },
        ],
        help: "Spatial origin of audio disturbances across the simulation canvas.",
      },
      {
        key: "cameraBreathing",
        label: "CAMERA BREATH",
        type: "select",
        default: "off",
        options: [
          {
            value: "off",
            label: "Off",
            guidance: "Camera stays fixed at manual zoom.",
          },
          {
            value: "subtle",
            label: "Subtle",
            guidance: "Gentle kick accents with smooth recovery.",
          },
          {
            value: "punchy",
            label: "Punchy",
            guidance: "Rhythmic zoom bounces and beat pulses.",
          },
          {
            value: "drift",
            label: "Drift & Breathe",
            guidance: "Deep bass breathing combined with slow harmonic drift.",
          },
        ],
        help: "Couples live audio to the camera viewport via optical zoom pulses and harmonic drift.",
      },
      {
        key: "cameraReactivity",
        label: "BREATH STRENGTH",
        type: "range",
        min: 0.10,
        max: 1.00,
        step: 0.05,
        default: 0.50,
        modulatable: true,
        help: "Sensitivity scaling for audio-reactive camera zoom pulses and breathing.",
      },
      {
        key: "brushRadius",
        label: "BRUSH RADIUS",
        type: "range",
        min: 4,
        max: 256,
        step: 1,
        default: 16,
        modulation: false,
        help: "Pointer disturbance and shockwave brush radius in grid cells.",
      },
      {
        key: "disturbanceMode",
        label: "DISTURBANCE MODE",
        type: "select",
        default: "erase",
        options: [
          {
            value: "erase",
            label: "Erase",
            compute: "light",
            tag: "clear",
            guidance: "Carves empty space. Small clearings heal; tap with Noise or Color to re-seed.",
          },
          {
            value: "noise",
            label: "Noise",
            compute: "balanced",
            tag: "re-seed",
            guidance: "Recommended for recovery. Injects organic entropy to sprout fresh growth.",
          },
          {
            value: "dye",
            label: "Color",
            compute: "neutral",
            tag: "color",
            guidance: "Injects vibrant pigment into cells while preserving hidden channels.",
          },
          {
            value: "invert",
            label: "Invert",
            compute: "neutral",
            tag: "invert",
            guidance: "Inverts cell polarity locally to generate high-contrast cellular blooms.",
          },
          {
            value: "shockwave",
            label: "Ripple",
            compute: "balanced",
            tag: "ripple",
            guidance: "Emits expanding optical ripples and fluid disturbances from pointer taps.",
          },
          {
            value: "infuse",
            label: "Infuse",
            compute: "balanced",
            tag: "detail",
            guidance: "Injects hidden-channel variation for cells to organically weave into new texture.",
          },
          {
            value: "prune",
            label: "Prune",
            compute: "balanced",
            tag: "relax",
            guidance: "Relaxes hidden-channel overgrowth toward equilibrium without erasing surface colors.",
          },
          {
            value: "freeze",
            label: "Freeze",
            compute: "neutral",
            tag: "barrier",
            guidance: "Locks cells in place with a frozen barrier protected from surrounding growth.",
          },
          {
            value: "thaw",
            label: "Unfreeze",
            compute: "neutral",
            tag: "release",
            guidance: "Unfreezes barriers, returning frozen cells back into active growth.",
          },
          {
            value: "groom",
            label: "Flow",
            compute: "neutral",
            tag: "flow",
            guidance: "Aligns directional perception filters along pointer brush drag angles.",
          },
        ],
        help: "Interactive brush: Erase, Noise, Color, Invert, Ripple, Infuse detail, Prune overgrowth, Freeze barrier, Unfreeze barrier, or Flow direction.",
      },
      {
        key: "dyeColor",
        label: "BRUSH COLOR",
        type: "color",
        default: "#00f0ff",
        presets: [
          { label: "Cyan", value: "#00f0ff" },
          { label: "Magenta", value: "#ff00a0" },
          { label: "Gold", value: "#ffb800" },
          { label: "Lime", value: "#00ff66" },
          { label: "Violet", value: "#9d4edd" },
          { label: "White", value: "#ffffff" },
        ],
        help: "Color pigment for Color brush. Injects RGB states while preserving hidden channels.",
      },
      {
        key: "barrierOutline",
        label: "BARRIER OUTLINE",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto · While Active" },
          { value: "always", label: "Always On" },
          { value: "off", label: "Off" },
        ],
        help: "Visibility of dashed inverted outlines along frozen barrier borders.",
      },
      {
        key: "barrierLock",
        label: "FREEZE LOCK",
        type: "select",
        default: "mask",
        options: [
          { value: "mask", label: "Mask · Protected" },
          { value: "draw", label: "Draw · Editable" },
        ],
        help: "Mask prevents brushes and growth from modifying frozen cells; Draw permits custom painting on frozen cells before unfreezing.",
      },
      {
        key: "topology",
        label: "GRID TOPOLOGY",
        type: "select",
        default: "square",
        options: [
          { value: "square", label: "Square · 8 Neighbors" },
          { value: "hexagonal", label: "Hexagonal · 6 Neighbors" },
        ],
        help: "Switches cell neighborhood geometry. Hexagonal topology introduces 6-fold radial symmetry.",
      },
      {
        key: "zoom",
        label: "ZOOM",
        type: "select",
        default: 1,
        options: [
          { value: 1, label: "1× · Full Field" },
          { value: 2, label: "2× · Cell Detail" },
          { value: 4, label: "4× · Pixel Grid" },
        ],
        help: "Inspects discrete cell states with nearest-neighbor magnification without altering simulation.",
      },
      {
        key: "palette",
        label: "DISPLAY PALETTE",
        type: "select",
        default: "native",
        options: [
          {
            value: "native",
            label: "Native RGB · Original Hue",
            compute: "neutral",
            tag: "original",
            guidance: "Learned checkpoint colors. Phase drift smoothly rotates hue wheel.",
          },
          {
            value: "spectral",
            label: "Spectral · Rainbow Prism",
            compute: "balanced",
            tag: "rainbow",
            guidance: "Balanced full-spectrum prism. Phase drift flows through all rainbow hues.",
          },
          {
            value: "thermal",
            label: "Thermal · Inferno Heat",
            compute: "balanced",
            tag: "inferno",
            guidance: "High-contrast heat gradient from deep violet through flame amber to white.",
          },
          {
            value: "neon",
            label: "Neon · Synthwave Glow",
            compute: "balanced",
            tag: "synthwave",
            guidance: "Vibrant retro-futurist glow through cyan, magenta, and electric violet.",
          },
          {
            value: "ocean",
            label: "Ocean · Bioluminescence",
            compute: "balanced",
            tag: "deep sea",
            guidance: "Abyssal marine depth through midnight blue, aqua, and emerald bioluminescence.",
          },
          {
            value: "verdant",
            label: "Verdant · Forest Flora",
            compute: "balanced",
            tag: "botanical",
            guidance: "Organic botanical flora through deep moss, jade, and golden pollen.",
          },
        ],
        help: "Display color mapping and cosine spectrum projection. Does not alter underlying cell state or update rules.",
      },
      {
        key: "palettePhase",
        label: "PALETTE PHASE",
        type: "range",
        min: 0,
        max: 360,
        step: 1,
        default: 0,
        wrap: true,
        format: "degrees",
        help: "Manual phase offset in degrees across the color spectrum. Modulate via LFO or audio beat.",
        getGuidance: (value) => {
          const v = Math.round(Number(value) || 0) % 360;
          if (v === 0) {
            return {
              compute: "neutral",
              tag: "aligned",
              text: "Default palette phase alignment.",
            };
          }
          return {
            compute: "gentle",
            tag: `${v}° shift`,
            text: `Phase shifted ${v}° across the color spectrum.`,
          };
        },
      },
      {
        key: "paletteCycleSpeed",
        label: "PALETTE DRIFT SPEED",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        default: 0,
        format: "percent",
        help: "Speed of continuous automatic phase drift across palette colors. Zero holds phase stationary.",
        getGuidance: (value) => {
          const v = Number(value) || 0;
          if (v <= 0.001) {
            return {
              compute: "neutral",
              tag: "stationary",
              text: "Stationary palette. No automatic phase drift.",
            };
          }
          if (v <= 0.15) {
            return {
              compute: "balanced",
              tag: "slow drift",
              text: "Recommended. Slow, hypnotic color cycling that complements pattern evolution.",
            };
          }
          if (v <= 0.50) {
            return {
              compute: "gentle",
              tag: "flowing",
              text: "Gentle rhythmic color stream across cell boundaries.",
            };
          }
          return {
            compute: "moderate",
            tag: "rapid",
            text: "Accelerated psychedelic color cycling.",
          };
        },
      },
      {
        key: "channelView",
        label: "CHANNEL INSPECTOR",
        type: "select",
        default: "phenotype",
        options: [
          {
            value: "phenotype",
            label: "Phenotype · Native RGB",
            compute: "neutral",
            tag: "recommended",
            guidance: "Recommended. Visible surface texture rendered in full color.",
          },
          {
            value: "vitality",
            label: "Vitality · Cell Mask (α)",
            compute: "neutral",
            tag: "alpha mask",
            guidance: "Alpha mask channel. Shows living density and growth boundaries.",
          },
          {
            value: "fast_signals",
            label: "Hidden 1 · Fast Signals (Ch 4-6)",
            compute: "neutral",
            tag: "ch 4-6",
            guidance: "Internal hidden channels 4-6. Choose Phenotype to see the texture.",
          },
          {
            value: "memory_waves",
            label: "Hidden 2 · Memory Waves (Ch 8-10)",
            compute: "neutral",
            tag: "ch 8-10",
            guidance: "Internal hidden channels 8-10. Choose Phenotype to see the texture.",
          },
          {
            value: "energy_heat",
            label: "Energy · Metabolic Heatmap",
            compute: "balanced",
            tag: "heatmap",
            guidance: "Hidden-state magnitude heatmap showing overall network activation.",
          },
          {
            value: "xray",
            label: "Neural X-Ray · Phenotype + Glow",
            compute: "balanced",
            tag: "composite",
            guidance: "Composite view fusing surface colors with glowing hidden-state energy.",
          },
        ],
        help: "Inspects hidden biochemical and electrical memory channels operating beneath the living pattern.",
      },
      {
        key: "displayFilter",
        label: "DISPLAY FILTER",
        type: "select",
        default: "smooth",
        options: [
          {
            value: "smooth",
            label: "Smooth · Bicubic Catmull-Rom",
            compute: "neutral",
            guidance: "C1-continuous bicubic reconstruction. Cleaner edges and high-definition detail without blur.",
          },
          {
            value: "crisp",
            label: "Crisp · Pixel Grid",
            compute: "efficient",
            guidance: "Discrete nearest-neighbor cell squares.",
          },
        ],
        help: "Viewport rendering fidelity: Smooth bicubic Catmull-Rom reconstruction or crisp pixel grid.",
      },
      {
        key: "echoDecay",
        label: "TEMPORAL ECHO DECAY",
        type: "range",
        min: 0,
        max: 0.98,
        step: 0.02,
        default: 0.0,
        format: "percent",
        help: "Persistence of previous frames as fading impressions. 0% disables echoes; 75% creates fluid comet wakes; 95% gives long phosphor dreams.",
        getGuidance: (value) => {
          const v = Number(value) || 0;
          if (v <= 0.01) {
            return {
              compute: "neutral",
              tag: "disabled",
              text: "Instantaneous display. Zero temporal echo persistence.",
            };
          }
          if (v <= 0.40) {
            return {
              compute: "gentle",
              tag: "subtle wake",
              text: "Subtle motion trail behind moving fronts.",
            };
          }
          if (v <= 0.75) {
            return {
              compute: "balanced",
              tag: "comet wake",
              text: "Fluid luminous trails and drifting wake impressions.",
            };
          }
          return {
            compute: "moderate",
            tag: "phosphor dream",
            text: "Long-lasting phosphor persistence with slow dissolution.",
          };
        },
      },
      {
        key: "echoDrift",
        label: "TEMPORAL ECHO DRIFT",
        type: "range",
        min: -1,
        max: 1,
        step: 0.05,
        default: 0.25,
        help: "Drift velocity and direction of fading impressions along vector flow streamlines.",
        getGuidance: (value) => {
          const v = Number(value) || 0;
          if (Math.abs(v) <= 0.05) {
            return {
              compute: "neutral",
              tag: "stationary",
              text: "Impressions fade in place without spatial drift.",
            };
          }
          if (v > 0.05) {
            return {
              compute: "balanced",
              tag: "downstream",
              text: `Drifts downstream along flow streamlines (${Math.round(v * 100)}%).`,
            };
          }
          return {
            compute: "balanced",
            tag: "counter-stream",
            text: `Drifts upstream against flow currents (${Math.round(v * 100)}%).`,
          };
        },
      },
      {
        key: "echoMode",
        label: "ECHO FLOW DYNAMICS",
        type: "select",
        default: "field_advection",
        options: [
          {
            value: "field_advection",
            label: "Vector Flow · Advection",
            compute: "balanced",
            tag: "flow field",
            guidance: "Echoes advect along the active coordinate geometry currents (spirals, waves, saddles, Voronoi).",
          },
          {
            value: "radial_bloom",
            label: "Radial Bloom · Outward Expansion",
            compute: "gentle",
            tag: "radial",
            guidance: "Echoes expand radially outward from the focal center as they fade.",
          },
          {
            value: "linear_drift",
            label: "Directional · Lateral Stream",
            compute: "gentle",
            tag: "linear",
            guidance: "Echoes stream uniformly along the global perception rotation angle.",
          },
        ],
        help: "Determines the spatial trajectory that fading impressions follow across display frames.",
      },
      {
        key: "echoStyle",
        label: "ECHO BLEND STYLE",
        type: "select",
        default: "phosphor",
        options: [
          {
            value: "phosphor",
            label: "Phosphor · Luminous Hold",
            compute: "balanced",
            tag: "phosphor",
            guidance: "Maximum-intensity hold. Retains glowing highlights like classic CRT phosphors.",
          },
          {
            value: "mist",
            label: "Mist · Ethereal Smoke",
            compute: "gentle",
            tag: "diffuse",
            guidance: "Soft-light linear blending. Yields silky motion blur and ethereal smoke trails.",
          },
        ],
        help: "Blending operator used to combine current frames with fading historical impressions.",
      },
      {
        key: "dreamEnabled",
        label: "DREAM GUIDANCE",
        type: "select",
        default: "off",
        options: [
          {
            value: "off",
            label: "Off · Vanilla Growth",
            compute: "neutral",
            guidance: "Default. Pure cellular automaton growth rules.",
          },
          {
            value: "on",
            label: "On · Inception Guided",
            compute: "balanced",
            guidance: "Couples live InceptionV3 perceptual gradient ascent into the growing pattern.",
          },
        ],
        help: "Injects live InceptionV3 perceptual gradients into the visible cell phenotype.",
      },
      {
        key: "dreamStrength",
        label: "DREAM STRENGTH",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        default: 0.0,
        modulation: false,
        help: "Perceptual gradient injection strength into visible phenotype cells.",
        getGuidance: (value) => {
          const s = Number(value) || 0;
          if (s <= 0.001) {
            return {
              compute: "neutral",
              tag: "dormant",
              text: "No perceptual gradients injected. Vanilla cellular growth.",
            };
          }
          if (s <= 0.15) {
            return {
              compute: "balanced",
              tag: "subtle",
              text: "Subtle perceptual guidance. Preserves organic cellular texture while coaxing motifs.",
            };
          }
          if (s <= 0.40) {
            return {
              compute: "balanced",
              tag: "pronounced",
              text: "Pronounced dream motifs. Inception features emerge visibly in cellular colonies.",
            };
          }
          return {
            compute: "intensive",
            tag: "intense",
            text: "Strong feature attractor. Deep dream forms dominate cellular morphogenesis.",
          };
        },
      },
      {
        key: "dreamCadence",
        label: "DREAM CADENCE",
        type: "range",
        min: 1,
        max: 32,
        step: 1,
        default: 8,
        modulation: false,
        help: "Evaluate Inception perceptual gradients every K cellular steps.",
        getGuidance: (value) => {
          const k = Math.round(Number(value) || 8);
          if (k <= 4) {
            return {
              compute: "intensive",
              tag: "rapid",
              text: "Evaluates every 1-4 steps. Fast guidance, high GPU load.",
            };
          }
          if (k <= 12) {
            return {
              compute: "balanced",
              tag: "recommended",
              text: `Recommended (${k} steps). Fluid perceptual guidance with locked 60fps simulation.`,
            };
          }
          return {
            compute: "light",
            tag: "relaxed",
            text: `Evaluates every ${k} steps. Relaxed guidance, minimal compute overhead.`,
          };
        },
      },
      {
        key: "targetLayer",
        label: "DREAM LAYER",
        type: "select",
        default: "mixed_6c",
        options: [
          {
            value: "mixed_6c",
            label: "Mixed_6c · Regional Contours",
            compute: "balanced",
            guidance: "Recommended. Intermediate organic contours and circular motifs.",
          },
          {
            value: "mixed_6a",
            label: "Mixed_6a · Mid-Level Features",
            compute: "balanced",
            guidance: "Rich intermediate textural motifs and flowing patterns.",
          },
          {
            value: "mixed_5b",
            label: "Mixed_5b · Early Lattices",
            compute: "balanced",
            guidance: "High-frequency geometric lattices and fine edge details.",
          },
          {
            value: "mixed_7b",
            label: "Mixed_7b · Deep Semantic Forms",
            compute: "balanced",
            guidance: "Macro-scale semantic representations and deep architectural forms.",
          },
        ],
        help: "InceptionV3 layer depth for perceptual feature ascent guidance.",
      },
      {
        key: "targetChannel",
        label: "DREAM NEURON",
        type: "range",
        min: -1,
        max: 767,
        step: 1,
        default: -1,
        format: "integer",
        modulation: false,
        help: "Single feature channel (neuron) index to target, or -1 to optimize all channels simultaneously.",
        getGuidance: (value) => {
          const ch = Math.round(Number(value));
          if (ch < 0) {
            return {
              compute: "balanced",
              tag: "all-neurons",
              text: "Optimizing all feature channels in the layer simultaneously.",
            };
          }
          return {
            compute: "intensive",
            tag: `neuron #${ch}`,
            text: `Isolating feature map channel #${ch} for single-neuron feature ascent.`,
          };
        },
      },
      {
        key: "dreamJitter",
        label: "DREAM JITTER",
        type: "select",
        default: "on",
        options: [
          {
            value: "on",
            label: "On · Spatial Roll",
            compute: "balanced",
            guidance: "Shifts input randomly by [-8, 8] px each cadence to diffuse dream motifs across boundaries.",
          },
          {
            value: "off",
            label: "Off · Static Alignment",
            compute: "neutral",
            guidance: "Fixes coordinate alignment to grid center without spatial translations.",
          },
        ],
        help: "Random circular spatial roll during gradient ascent to eliminate edge seam artifacts.",
      },
      {
        key: "dreamTvWeight",
        label: "DREAM SMOOTHNESS (TV)",
        type: "range",
        min: 0.0,
        max: 0.05,
        step: 0.001,
        default: 0.005,
        modulation: false,
        help: "Total Variation regularizer penalizing pixel-to-pixel discontinuity and high-frequency static.",
        getGuidance: (value) => {
          const w = Number(value) || 0;
          if (w <= 0.0005) {
            return {
              compute: "neutral",
              tag: "raw",
              text: "Minimal TV penalty. Maximum feature contrast, higher static risk.",
            };
          }
          if (w <= 0.015) {
            return {
              compute: "balanced",
              tag: "clean",
              text: "Balanced TV regularization. Eliminates checkerboard static while retaining contours.",
            };
          }
          return {
            compute: "gentle",
            tag: "soft",
            text: "Strong smoothness prior. Coaxes soft, painterly macro structures.",
          };
        },
      },
      {
        key: "dreamChroma",
        label: "DREAM CHROMINANCE",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.05,
        default: 0.0,
        format: "percent",
        modulation: false,
        help: "Ratio of chromatic color gradient versus structural luminance contrast. 0% is strictly achromatic structure.",
        getGuidance: (value) => {
          const c = Number(value) || 0;
          if (c <= 0.01) {
            return {
              compute: "balanced",
              tag: "structural",
              text: "Zero color alteration. Guides morphology and edges purely via luminance contrast.",
            };
          }
          if (c <= 0.3) {
            return {
              compute: "balanced",
              tag: "subtle",
              text: "Gentle pastel tints over structural contours.",
            };
          }
          return {
            compute: "intensive",
            tag: "vivid",
            text: "Full multi-channel color gradients.",
          };
        },
      },
    ];
  }

  get ready() {
    return Boolean(
      this._runtime &&
      !this._loadingPattern &&
      !this._needsRuntime &&
      !this.lastError &&
      !this._disposed,
    );
  }
  get state() {
    return this.lastError ? "ERROR" : this.ready ? "READY" : "LOADING";
  }
  get activePattern() {
    return this._activePattern;
  }
  get parameters() {
    return this._parameters;
  }
  get technicalInfo() {
    return getPattern(this._activePattern || DEFAULT_PATTERN).technicalInfo;
  }
  get capabilities() {
    return this._capabilities;
  }
  set capabilities(caps) {
    this._capabilities = caps;
  }
  get simulationSize() {
    return this._runtime?.size || this._parameters.simulationSize;
  }
  getStats() {
    return this._runtime?.getStats() || null;
  }
  isDormant() {
    return Boolean(this._runtime?.isDormant?.());
  }
  get hasActiveRipples() {
    if (!this._activeRipples || this._activeRipples.length === 0) return false;
    const now = performance.now();
    this._activeRipples = this._activeRipples.filter(
      (r) => now - r.startTime < r.duration * 1000,
    );
    return this._activeRipples.length > 0;
  }

  isDynamic(parameters) {
    return (
      !this.lastError &&
      !this._loadingPattern &&
      !this._disposed &&
      ((this._clockRunning && Number(parameters.growthSpeed) > 0) ||
        this.hasActiveRipples ||
        Math.abs(Number(parameters?.paletteCycleSpeed || 0)) > 0.001 ||
        Number(parameters?.echoDecay || 0) > 0.01 ||
        (parameters?.cameraBreathing !== "off" &&
          Boolean(this._cameraMotion?.isMoving)))
    );
  }

  get isClockRunning() {
    return this._clockRunning;
  }

  setClockRunning(running) {
    if (this._clockRunning !== Boolean(running)) {
      this._lastTick = null;
      this._accumulator = 0;
      this._clockRunning = Boolean(running);
    }
  }

  cancel() {
    this._epoch += 1;
    this._abort?.abort();
    this._abort = null;
    this._loadingPattern = false;
    this._queuedDisturbances = [];
    this._lastKickInputTime = 0;
    this._kickInputBudget = 0;
    this._kickInputIndex = 0;
    this.setClockRunning(false);
  }

  waitForIdle() {
    return this._pending || Promise.resolve();
  }

  parameterDefaultsForChange(key, value) {
    if (key === "pattern") {
      const startup = getPattern(value).startup;
      if (!startup) return null;
      return { seed: startup.seed };
    }
    if (key === "coordinateTransform") {
      if (value === "spiral") return { twist: 35 };
      if (
        value === "vortex" ||
        value === "wave" ||
        value === "saddle" ||
        value === "kaleidoscope" ||
        value === "vortex_pair" ||
        value === "voronoi" ||
        value === "julia" ||
        value === "dipole" ||
        value === "cartesian"
      ) {
        return { twist: 0 };
      }
    }
    if (key === "resonanceMode") {
      const preset = RESONANCE_PRESETS[value];
      if (preset && value !== "custom") {
        return {
          resonanceDrift: preset.perceptionDrift ?? 0.0,
          resonanceFeedback: preset.latentFeedback ?? 0.0,
          resonanceNoise: preset.noiseStrength ?? 0.0,
          resonanceWarp: preset.activationWarp ?? 0.0,
        };
      }
    }
    return null;
  }

  _getResonanceConfig() {
    const mode = this._parameters?.resonanceMode || "off";
    if (mode === "off") {
      return new ResonanceConfig({ enabled: false });
    }
    const preset = RESONANCE_PRESETS[mode];
    const drift = this._parameters?.resonanceDrift !== undefined
      ? Number(this._parameters.resonanceDrift)
      : (preset?.perceptionDrift ?? 0.0);
    const feedback = this._parameters?.resonanceFeedback !== undefined
      ? Number(this._parameters.resonanceFeedback)
      : (preset?.latentFeedback ?? 0.0);
    const noise = this._parameters?.resonanceNoise !== undefined
      ? Number(this._parameters.resonanceNoise)
      : (preset?.noiseStrength ?? 0.0);
    const warp = this._parameters?.resonanceWarp !== undefined
      ? Number(this._parameters.resonanceWarp)
      : (preset?.activationWarp ?? 0.0);

    return new ResonanceConfig({
      enabled: true,
      perceptionDrift: drift,
      latentFeedback: feedback,
      latentDecay: preset?.latentDecay ?? 0.98,
      noiseStrength: noise,
      activationWarp: warp,
    });
  }

  normalizeStoredParameter(key, value) {
    if (key === "audioProfile") {
      if (value === "ambient" || value === "rhythm") {
        return "custom";
      }
    }
    if (key === "beatShockwave") {
      if (value === "off") return "off";
      return "on";
    }
    if (key === "shockwaveIntensity") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.30;
    }
    if (key === "acousticInjection") {
      if (ACOUSTIC_INJECTION_MODES.includes(value)) return value;
      return "off";
    }
    if (key === "acousticThreshold") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.20, Math.min(0.80, num));
      }
      return 0.45;
    }
    if (key === "acousticPosition") {
      if (ACOUSTIC_POSITION_MODES.includes(value)) return value;
      return "curve_peaks";
    }
    if (key === "cameraBreathing") {
      if (CAMERA_BREATHING_MODES.includes(value)) return value;
      return "off";
    }
    if (key === "cameraReactivity") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.10, Math.min(1.00, num));
      }
      return 0.50;
    }
    if (key === "channelView") {
      const valid = [
        "phenotype",
        "vitality",
        "fast_signals",
        "memory_waves",
        "energy_heat",
        "xray",
      ];
      if (!valid.includes(value)) {
        return "phenotype";
      }
    }
    if (key === "simulationSize") {
      const num = Number(value);
      if (num === 1024) {
        if ((this._capabilities?.maxTextureSize ?? 0) < 16384) {
          return 256;
        }
        return 1024;
      }
      if (num === 512) {
        if ((this._capabilities?.maxTextureSize ?? 0) < 12288) {
          return 256;
        }
        return 512;
      }
      if (num === 128) return 128;
      return 256;
    }
    if (key === "displayFilter") {
      if (value === "crisp") return "crisp";
      return "smooth";
    }
    if (key === "brushRadius") {
      const num = Number(value);
      if (!Number.isFinite(num)) return 16;
      const maxSize = Math.floor(
        (this._runtime?.size || this._parameters?.simulationSize || 256) / 2,
      );
      return Math.max(4, Math.min(Math.min(256, maxSize), Math.round(num)));
    }
    if (key === "coordinateTransform") {
      const valid = [
        "cartesian",
        "spiral",
        "vortex",
        "wave",
        "saddle",
        "kaleidoscope",
        "vortex_pair",
        "voronoi",
        "julia",
        "dipole",
      ];
      if (valid.includes(value)) return value;
      return "cartesian";
    }
    if (key === "resonanceMode") {
      const valid = ["off", "subtle", "full", "custom"];
      if (valid.includes(value)) return value;
      return "off";
    }
    if (key === "resonanceDrift") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(-0.2, Math.min(0.2, num));
      }
      return 0.0;
    }
    if (key === "resonanceFeedback") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(0.95, num));
      }
      return 0.0;
    }
    if (key === "resonanceNoise") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(0.5, num));
      }
      return 0.0;
    }
    if (key === "resonanceWarp") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    if (key === "geometryStrength") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 1.0;
    }
    if (key === "geometryCenterX") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(-1.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    if (key === "geometryCenterY") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(-1.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    if (key === "geometrySoftness") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.25;
    }
    if (key === "palette") {
      const valid = ["native", "spectral", "thermal", "neon", "ocean", "verdant"];
      if (valid.includes(value)) return value;
      return "native";
    }
    if (key === "palettePhase") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return ((Math.round(num) % 360) + 360) % 360;
      }
      return 0;
    }
    if (key === "paletteCycleSpeed") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    if (key === "echoDecay") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(0.98, num));
      }
      return 0.0;
    }
    if (key === "echoDrift") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(-1.0, Math.min(1.0, num));
      }
      return 0.25;
    }
    if (key === "echoMode") {
      const valid = ["field_advection", "radial_bloom", "linear_drift"];
      if (valid.includes(value)) return value;
      return "field_advection";
    }
    if (key === "echoStyle") {
      const valid = ["phosphor", "mist"];
      if (valid.includes(value)) return value;
      return "phosphor";
    }
    if (key === "dreamEnabled") {
      return value === "on" || value === true ? "on" : "off";
    }
    if (key === "dreamStrength") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    if (key === "dreamCadence") {
      const num = Math.round(Number(value));
      if (Number.isInteger(num)) {
        return Math.max(1, Math.min(32, num));
      }
      return 8;
    }
    if (key === "targetLayer") {
      const valid = ["mixed_5b", "mixed_6a", "mixed_6c", "mixed_7b"];
      if (valid.includes(value)) return value;
      return "mixed_6c";
    }
    if (key === "targetChannel") {
      const num = Math.round(Number(value));
      if (Number.isFinite(num)) {
        return Math.max(-1, Math.min(767, num));
      }
      return -1;
    }
    if (key === "dreamJitter") {
      return value === "off" || value === false ? "off" : "on";
    }
    if (key === "foldCount") {
      const num = Math.round(Number(value));
      if (Number.isFinite(num)) {
        return Math.max(3, Math.min(12, num));
      }
      return 6;
    }
    if (key === "latentMomentum") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(0.9, num));
      }
      return 0.0;
    }
    if (key === "dreamTvWeight") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(0.05, num));
      }
      return 0.005;
    }
    if (key === "dreamChroma") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return Math.max(0.0, Math.min(1.0, num));
      }
      return 0.0;
    }
    return value;
  }

  onParameterChange(key, value) {
    if (this._parameters && key in this._parameters) {
      this._parameters[key] = value;
    }
    if (
      key === "echoDecay" ||
      key === "echoDrift" ||
      key === "echoMode" ||
      key === "echoStyle" ||
      key === "dreamEnabled" ||
      key === "dreamStrength" ||
      key === "dreamCadence" ||
      key === "targetLayer" ||
      key === "targetChannel" ||
      key === "dreamJitter" ||
      key === "dreamTvWeight" ||
      key === "dreamChroma" ||
      key === "foldCount" ||
      key === "latentMomentum" ||
      key === "palette" ||
      key === "palettePhase" ||
      key === "paletteCycleSpeed" ||
      key === "coordinateTransform" ||
      key === "geometryStrength" ||
      key === "geometryCenterX" ||
      key === "geometryCenterY" ||
      key === "geometrySoftness" ||
      key === "barrierLock" ||
      key === "audioProfile" ||
      key === "beatShockwave" ||
      key === "shockwaveIntensity" ||
      key === "acousticInjection" ||
      key === "acousticThreshold" ||
      key === "acousticPosition" ||
      key === "cameraBreathing" ||
      key === "cameraReactivity" ||
      key === "channelView" ||
      key === "displayFilter" ||
      key === "brushRadius" ||
      key === "resonanceMode" ||
      key === "resonanceDrift" ||
      key === "resonanceFeedback" ||
      key === "resonanceNoise" ||
      key === "resonanceWarp"
    ) {
      if (key === "resonanceMode") {
        const preset = RESONANCE_PRESETS[value];
        if (preset && value !== "off" && value !== "custom") {
          this._parameters.resonanceDrift = preset.perceptionDrift ?? 0.0;
          this._parameters.resonanceFeedback = preset.latentFeedback ?? 0.0;
          this._parameters.resonanceNoise = preset.noiseStrength ?? 0.0;
          this._parameters.resonanceWarp = preset.activationWarp ?? 0.0;
        }
      } else if (
        key === "resonanceDrift" ||
        key === "resonanceFeedback" ||
        key === "resonanceNoise" ||
        key === "resonanceWarp"
      ) {
        if (
          this._parameters.resonanceMode !== "off" &&
          this._parameters.resonanceMode !== "custom"
        ) {
          this._parameters.resonanceMode = "custom";
        }
      }
      return true;
    }
    if (key !== "pattern" || value === this._requestedPattern) return false;
    getPattern(value);
    this._requestedPattern = value;
    this._epoch += 1;
    this._abort?.abort();
    this._abort = null;
    this._loadingPattern = false;
    this._lastTick = null;
    this._accumulator = 0;
    return true;
  }

  render(canvas, parameters, timeSeconds, { advanceSimulation = false } = {}) {
    const sanitized = sanitizeParameters(this, parameters);
    this.onParameterChange("pattern", sanitized.pattern);
    const epoch = this._epoch;
    const task = this._render(
      canvas,
      sanitized,
      timeSeconds,
      advanceSimulation,
      epoch,
    );
    this._pending = task;
    return task.finally(() => {
      if (this._pending === task) this._pending = null;
    });
  }

  async _render(canvas, parameters, timeSeconds, advance, epoch) {
    if (this._disposed) return null;
    const configuration = `${parameters.pattern}:${parameters.simulationSize}:${parameters.seed}`;
    let candidate = null;
    let runtimeOperation = false;
    try {
      if (this.lastError && configuration === this._failedConfiguration) {
        // Redraw the retained state after viewport resizing, if its context is
        // still usable. Never allocate or restart automatically after failure.
        if (this._runtime && !this._runtime.getStats().contextLost)
          this._runtime.draw(canvas, this._parameters.palette);
        return this._result();
      }
      const pattern = getPattern(parameters.pattern);
      let checkpoint = this._checkpoints.get(pattern.id);
      if (!checkpoint) {
        const abort = new AbortController();
        this._abort = abort;
        this._loadingPattern = true;
        try {
          const raw = await this._load(abort.signal, pattern);
          if (epoch !== this._epoch || this._disposed) return null;
          checkpoint = validateCheckpoint(raw);
          if (checkpoint.id !== pattern.id)
            throw new Error("Checkpoint does not match the selected pattern.");
          this._checkpoints.set(pattern.id, checkpoint);
          if (this._checkpoints.size > 16) {
            const oldestKey = this._checkpoints.keys().next().value;
            this._checkpoints.delete(oldestKey);
          }
        } finally {
          if (this._abort === abort) {
            this._abort = null;
            this._loadingPattern = false;
          }
        }
      }
      if (epoch !== this._epoch || this._disposed) return null;
      if (Number.isFinite(timeSeconds)) {
        if (this._lastPaletteTime !== null) {
          const dt = Math.max(0, Math.min(0.1, timeSeconds - this._lastPaletteTime));
          const driftSpeed = Number(parameters.paletteCycleSpeed || 0);
          if (Math.abs(driftSpeed) > 0.0001) {
            this._palettePhaseAccumulator =
              (this._palettePhaseAccumulator + dt * driftSpeed * Math.PI) % (Math.PI * 2);
          }
        }
        this._lastPaletteTime = timeSeconds;
      }
      const manualPhaseRad = ((Number(parameters.palettePhase || 0) % 360) * Math.PI) / 180;
      const effectivePhaseRad =
        (manualPhaseRad + (this._palettePhaseAccumulator || 0)) % (Math.PI * 2);

      if (
        !this._runtime ||
        this._activePattern !== pattern.id ||
        this._runtime.size !== parameters.simulationSize ||
        this._needsRuntime
      ) {
        // Build and draw privately before committing. Failed grid changes retain
        // the old state and displayed frame instead of repeatedly clearing them.
        candidate = this._createRuntime({
          model: checkpoint,
          size: parameters.simulationSize,
          seed: parameters.seed,
        });
        const isGridResize = Boolean(
          this._runtime &&
          this._activePattern === pattern.id &&
          this._runtime.size !== parameters.simulationSize &&
          !this._needsRuntime &&
          (this._runtime.steps || 0) > 0,
        );
        if (
          isGridResize &&
          typeof this._runtime.readState === "function" &&
          typeof candidate.writeState === "function"
        ) {
          try {
            const oldData = this._runtime.readState();
            if (oldData instanceof Uint8Array) {
              const tiledData = tileState(
                oldData,
                this._runtime.size,
                parameters.simulationSize,
              );
              candidate.writeState(tiledData);
              candidate.steps = this._runtime.steps;
            }
          } catch (_) {
            // Retain fresh seed state if state reading or writing throws
          }
        }
        const preview = document.createElement("canvas");
        preview.width = canvas.width;
        preview.height = canvas.height;
        candidate.draw(preview, {
          palette: parameters.palette,
          palettePhase: effectivePhaseRad,
          zoom: parameters.zoom,
          displayFilter: parameters.displayFilter,
          channelView: parameters.channelView,
        });
        this._runtime?.dispose();
        this._runtime = candidate;
        this._activePattern = pattern.id;
        this._needsRuntime = false;
        this._lastTick = null;
        this._accumulator = 0;
        candidate = null;
      } else if (this._runtime.seed !== parameters.seed) {
        runtimeOperation = true;
        this._runtime.restart(parameters.seed);
        this._lastTick = null;
        this._accumulator = 0;
      }
      if (this._parameters.simulationSize !== parameters.simulationSize) {
        this._lastTick = null;
        this._accumulator = 0;
      }
      this._parameters = parameters;
      this.lastError = null;
      this._failedConfiguration = null;
      runtimeOperation = true;
      this._drainDisturbances();
      if (advance && this._clockRunning && Number.isFinite(timeSeconds)) {
        if (this._lastTick !== null) {
          const delta = Math.max(
            0,
            Math.min(0.05, timeSeconds - this._lastTick),
          );
          this._accumulator = Math.min(
            2,
            this._accumulator + delta * parameters.growthSpeed,
          );
          const count = Math.floor(this._accumulator + 1e-9);
          if (count) {
            const angleRad =
              (Number(parameters.rotation || 0) * Math.PI) / 180;
            const twistRad =
              (Number(parameters.twist || 0) * Math.PI) / 180;
            const isDreamActive =
              (parameters.dreamEnabled === "on" || parameters.dreamEnabled === true) &&
              Number(parameters.dreamStrength) > 0.0001;
            const effectiveDreamStrength = isDreamActive
              ? Number(parameters.dreamStrength)
              : 0.0;
            this._runtime.step(count, {
              rotation: angleRad,
              topology: parameters.topology,
              coordinateTransform: parameters.coordinateTransform,
              twist: twistRad,
              geometryStrength: parameters.geometryStrength,
              geometryCenterX: parameters.geometryCenterX,
              geometryCenterY: parameters.geometryCenterY,
              geometrySoftness: parameters.geometrySoftness,
              resonance: this._getResonanceConfig(),
              dreamStrength: effectiveDreamStrength,
              dreamChroma: Number(parameters.dreamChroma ?? 0.0),
              foldCount: parameters.foldCount,
              latentMomentum: parameters.latentMomentum,
            });
            if (isDreamActive) {
              this._dreamStepCounter += count;
              const cadence = Math.max(1, Math.round(Number(parameters.dreamCadence) || 8));
              if (this._dreamStepCounter >= cadence) {
                this._dreamStepCounter %= cadence;
                this._dispatchDreamGuidance(
                  parameters.targetLayer,
                  parameters.targetChannel,
                  parameters.dreamJitter !== "off",
                  parameters.dreamTvWeight,
                );
              }
            }
          }
          this._accumulator -= count;
        }
        this._lastTick = timeSeconds;
      }
      const outlineMode = parameters.barrierOutline || "auto";
      const showBarrier =
        outlineMode === "always" ||
        (outlineMode === "auto" &&
          (parameters.disturbanceMode === "freeze" ||
            parameters.disturbanceMode === "thaw"));
      if (this._activeRipples?.length) {
        const now = performance.now();
        this._activeRipples = this._activeRipples.filter(
          (r) => now - r.startTime < r.duration * 1000,
        );
      }
      const effectiveZoom =
        this._effectiveZoom > 0 ? this._effectiveZoom : parameters.zoom;
      this._runtime.draw(canvas, {
        palette: parameters.palette,
        palettePhase: effectivePhaseRad,
        zoom: effectiveZoom,
        pan: this._effectivePan || [0, 0],
        displayFilter: parameters.displayFilter,
        showBarrier,
        ripples: this._activeRipples || [],
        dyeColor: parameters.dyeColor,
        channelView: parameters.channelView,
        echoDecay: parameters.echoDecay,
        echoDrift: parameters.echoDrift,
        echoMode: parameters.echoMode,
        echoStyle: parameters.echoStyle,
      });
      return this._result();
    } catch (error) {
      candidate?.dispose();
      if (epoch !== this._epoch || this._disposed) return null;
      this._fail(error, configuration, { invalidateRuntime: runtimeOperation });
      return this._result();
    }
  }

  _fail(
    error,
    configuration = `${this._parameters.pattern}:${this._parameters.simulationSize}:${this._parameters.seed}`,
    { invalidateRuntime = true } = {},
  ) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this._failedConfiguration = configuration;
    this._needsRuntime ||= invalidateRuntime;
    this._lastTick = null;
    this._accumulator = 0;
  }

  _runRuntime(operation) {
    try {
      operation();
    } catch (error) {
      this._fail(error);
      throw error;
    }
  }

  _result() {
    const stats = this.getStats();
    return {
      backend: this.backend,
      status: this.lastError ? "error" : "ready",
      modelMetrics: {
        modelState: this.state,
        steps: stats?.steps || 0,
        gridSize: stats?.size || 0,
        textureBytes: stats?.resources.bytes || 0,
        pattern: this._activePattern,
      },
    };
  }

  step() {
    if (!this.ready) return;
    this._drainDisturbances();
    const angleRad = (Number(this._parameters.rotation || 0) * Math.PI) / 180;
    const twistRad = (Number(this._parameters.twist || 0) * Math.PI) / 180;
    const isDreamActive =
      (this._parameters.dreamEnabled === "on" || this._parameters.dreamEnabled === true) &&
      Number(this._parameters.dreamStrength) > 0.0001;
    const effectiveDreamStrength = isDreamActive
      ? Number(this._parameters.dreamStrength)
      : 0.0;
    this._runRuntime(() =>
      this._runtime.step(1, {
        rotation: angleRad,
        topology: this._parameters.topology,
        coordinateTransform: this._parameters.coordinateTransform,
        twist: twistRad,
        geometryStrength: this._parameters.geometryStrength,
        geometryCenterX: this._parameters.geometryCenterX,
        geometryCenterY: this._parameters.geometryCenterY,
        geometrySoftness: this._parameters.geometrySoftness,
        resonance: this._getResonanceConfig(),
        dreamStrength: effectiveDreamStrength,
        dreamChroma: Number(this._parameters.dreamChroma ?? 0.0),
        foldCount: this._parameters.foldCount,
        latentMomentum: this._parameters.latentMomentum,
      }),
    );
    if (isDreamActive) {
      this._dreamStepCounter += 1;
      const cadence = Math.max(1, Math.round(Number(this._parameters.dreamCadence) || 8));
      if (this._dreamStepCounter >= cadence) {
        this._dreamStepCounter %= cadence;
        this._dispatchDreamGuidance(
          this._parameters.targetLayer,
          this._parameters.targetChannel,
          this._parameters.dreamJitter !== "off",
          this._parameters.dreamTvWeight,
        );
      }
    }
    this._lastTick = null;
    this._accumulator = 0;
  }

  restart() {
    if (this.lastError) {
      // Explicit retry is the only way to repeat a failed configuration.
      this.lastError = null;
      this._failedConfiguration = null;
    } else {
      this._runRuntime(() => this._runtime?.restart(this._parameters.seed));
    }
    this._queuedDisturbances = [];
    this._lastKickInputTime = 0;
    this._kickInputBudget = 0;
    this._kickInputIndex = 0;
    this._lastTick = null;
    this._accumulator = 0;
    this._dreamStepCounter = 0;
    this._dreamBridge?.resetMomentum();
  }

  _dispatchDreamGuidance(targetLayer, targetChannel = -1, jitter = true, tvWeight = 0.005) {
    if (!this._runtime || !this._dreamBridge || this._dreamBridge.isBusy) {
      return;
    }
    try {
      const rgbBytes = this._runtime.readPhenotypeRgb(192, 192);
      this._dreamBridge
        .computeGradient(rgbBytes, 192, 192, targetLayer, targetChannel, jitter, tvWeight)
        .then((gradBytes) => {
          if (gradBytes && this._runtime && !this._runtime.disposed) {
            this._runtime.updateDreamGradient(gradBytes, 192, 192);
          }
        })
        .catch((error) => {
          console.warn("[DreamGuidance] Gradient evaluation error:", error);
        });
    } catch (err) {
      console.warn("[DreamGuidance] Phenotype read error:", err);
    }
  }

  setGeometryCenter(cx, cy) {
    const normX = Math.max(-1.0, Math.min(1.0, Number(cx) || 0));
    const normY = Math.max(-1.0, Math.min(1.0, Number(cy) || 0));
    this.onParameterChange("geometryCenterX", Math.round(normX * 100) / 100);
    this.onParameterChange("geometryCenterY", Math.round(normY * 100) / 100);
  }

  resetGeometryCenter() {
    this.setGeometryCenter(0, 0);
  }

  queueDisturbance(
    x,
    y,
    radius = Number(this._parameters.brushRadius) ||
      Math.max(2, Math.round(this.simulationSize * 0.06)),
    mode = this._parameters.disturbanceMode || "erase",
    options = {},
  ) {
    if (!this.ready) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const size = this.simulationSize;
    const clampedX = Math.max(0, Math.min(size - 1, Math.round(x)));
    const clampedY = Math.max(0, Math.min(size - 1, Math.round(y)));
    const clampedRadius = Math.max(
      1,
      Math.min(Math.floor(size / 2), Math.round(radius)),
    );
    if (mode === "shockwave") {
      this.triggerRipple(clampedX, clampedY, clampedRadius);
    }
    if (this._queuedDisturbances.length >= 64) {
      this._queuedDisturbances.shift();
    }
    this._queuedDisturbances.push({
      x: clampedX,
      y: clampedY,
      radius: clampedRadius,
      mode,
      dyeColor: options.dyeColor || this._parameters.dyeColor || "#00f0ff",
      strokeAngle: options.strokeAngle || 0,
      watercolor: Boolean(options.watercolor),
      organicSprout: Boolean(options.organicSprout),
    });
  }

  queueDisturbanceStroke(
    x0,
    y0,
    x1,
    y1,
    radius = Number(this._parameters.brushRadius) ||
      Math.max(2, Math.round(this.simulationSize * 0.06)),
    mode = this._parameters.disturbanceMode || "erase",
    options = {},
  ) {
    if (!this.ready) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const strokeAngle = Math.atan2(dy, dx);
    const step = Math.max(1, radius * 0.5);
    const count = Math.min(32, Math.max(1, Math.ceil(dist / step)));
    for (let i = 0; i <= count; i += 1) {
      const t = count === 0 ? 0 : i / count;
      this.queueDisturbance(x0 + dx * t, y0 + dy * t, radius, mode, {
        ...options,
        strokeAngle: options.strokeAngle ?? strokeAngle,
      });
    }
  }

  _drainDisturbances() {
    if (!this._runtime || this._queuedDisturbances.length === 0) return false;
    let applied = false;
    const lockBarrier = (this._parameters.barrierLock || "mask") === "mask";
    while (this._queuedDisturbances.length > 0) {
      const {
        x,
        y,
        radius,
        mode,
        dyeColor,
        strokeAngle,
        watercolor,
        organicSprout,
      } = this._queuedDisturbances.shift();
      try {
        const rgb = hexToRgb(dyeColor || this._parameters.dyeColor || "#00f0ff");
        if (mode && mode !== "erase") {
          const opts = {
            dyeColor: rgb,
            strokeAngle: strokeAngle || 0,
            lockBarrier,
          };
          let effectiveMode = mode;
          if (watercolor && mode === "dye") {
            effectiveMode = "kick_color";
            opts.strength = 0.85;
          } else if (organicSprout && (mode === "sprout" || mode === "noise")) {
            effectiveMode = "infuse";
            opts.strength = 1.0;
          } else if (mode === "shockwave") {
            opts.shockwaveImpact = this._parameters.shockwaveImpact || "color";
            opts.ringRadius = Math.max(6, Math.round(radius * 0.12));
            opts.ringWidth = Math.max(6, Math.min(24, radius * 0.1));
            opts.strength = 1.0;
          } else if (mode === "infuse") {
            opts.strength = 1.2;
          } else if (mode === "prune") {
            opts.strength = 0.85;
          }
          this._runtime.disturb(x, y, radius, effectiveMode, opts);
        } else {
          this._runtime.disturb(x, y, radius);
        }
        applied = true;
      } catch (_) {
        // Silently drop invalid coordinates
      }
    }
    return applied;
  }

  disturb(x, y, radius = Math.max(2, Math.round(this.simulationSize * 0.06))) {
    if (this.ready) {
      this.queueDisturbance(x, y, radius);
      this._drainDisturbances();
    }
  }

  clearBarrier() {
    if (this.ready) {
      this._runRuntime(() => this._runtime?.clearBarrier());
    }
  }

  triggerRipple(x, y, customRadius = null, maxAmplitude = null) {
    if (!this.ready) return false;
    const size = this.simulationSize;
    const originX = Math.max(
      0,
      Math.min(size - 1, Math.round(Number(x) || Math.floor(size / 2))),
    );
    const originY = Math.max(
      0,
      Math.min(size - 1, Math.round(Number(y) || Math.floor(size / 2))),
    );
    const reach = "canvas";
    let radius = 16;
    if (reach === "canvas") {
      const d1 = Math.hypot(originX, originY);
      const d2 = Math.hypot(size - originX, originY);
      const d3 = Math.hypot(originX, size - originY);
      const d4 = Math.hypot(size - originX, size - originY);
      radius = Math.ceil(Math.max(d1, d2, d3, d4));
    } else {
      const chosen =
        Number(customRadius || this._parameters?.brushRadius) || 16;
      radius = Math.max(8, Math.min(96, Math.round(chosen)));
    }
    const amp =
      maxAmplitude !== null && Number.isFinite(Number(maxAmplitude))
        ? Number(maxAmplitude)
        : Math.min(1.5, Math.max(0.8, radius * 0.015));
    const ripple = {
      x: originX,
      y: originY,
      radius,
      amplitude: amp,
      startTime: performance.now(),
      duration: 0.55,
    };
    if (!this._activeRipples) this._activeRipples = [];
    this._activeRipples.push(ripple);
    if (this._activeRipples.length > 4) {
      this._activeRipples.shift();
    }
    return true;
  }

  triggerBeatShockwave(
    mode = this._parameters.beatShockwave,
    coords = null,
    customRadius = null,
  ) {
    if (!this.ready || !mode || mode === "off") return false;
    const currentEnabled = this._parameters?.beatShockwave || "on";
    if (currentEnabled === "off" && mode !== "on" && mode !== "center") return false;
    const size = this.simulationSize;
    let x = Math.floor(size / 2);
    let y = Math.floor(size / 2);
    if (
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y)
    ) {
      x = coords.x;
      y = coords.y;
    }
    const d1 = Math.hypot(x, y);
    const d2 = Math.hypot(size - x, y);
    const d3 = Math.hypot(x, size - y);
    const d4 = Math.hypot(size - x, size - y);
    const radius = customRadius ? Math.round(customRadius) : Math.ceil(Math.max(d1, d2, d3, d4));
    const intensity = Number(this._parameters?.shockwaveIntensity ?? 0.30);
    this.triggerRipple(x, y, radius, intensity);
    return true;
  }

  processAcousticInjection(
    spectrum,
    levels,
    timestamp,
    rhythmController = null,
  ) {
    if (!this.ready || !this._parameters) return 0;
    const mode = this._parameters.acousticInjection || "off";
    if (mode === "off" || !levels?.hasSignal) return 0;

    if (!this._acousticEmitter) {
      this._acousticEmitter = new AcousticEmitter();
    }

    const count = this._acousticEmitter.process(spectrum, levels, timestamp, {
      mode,
      threshold: Number(this._parameters.acousticThreshold ?? 0.45),
      position: this._parameters.acousticPosition || "curve_peaks",
      simulationSize: this.simulationSize,
      geometryCenter: [
        Number(this._parameters.geometryCenterX) || 0,
        Number(this._parameters.geometryCenterY) || 0,
      ],
      brushRadius: Number(this._parameters.brushRadius) || 16,
      rhythmController,
      queueDisturbance: (x, y, radius, distMode, opts) => {
        this.queueDisturbance(x, y, radius, distMode, opts);
      },
    });

    return count;
  }

  processCameraMotion(levels, timestamp) {
    if (!this.ready || !this._parameters) return false;
    if (!this._cameraMotion) {
      this._cameraMotion = new CameraMotionEngine();
    }
    const motion = this._cameraMotion.update(levels, timestamp, this._parameters);
    const baseZoom = Number(this._parameters.zoom) || 1;
    this._effectiveZoom = Math.max(
      1,
      Math.min(8, baseZoom * (1.0 + motion.zoomOffset)),
    );
    this._effectivePan = [motion.panX, motion.panY];
    return motion.isMoving;
  }

  triggerKickInput(strength = 1.0, timestamp = null) {
    if (!this.ready) return false;
    const impact = this._parameters?.shockwaveImpact || "color";
    if (impact === "none") return false;

    const now = typeof timestamp === "number" ? timestamp : performance.now();
    const elapsed = now - (this._lastKickInputTime || 0);

    // Refractory lockout: at least 180 ms between kick inputs
    if (elapsed < 180) return false;

    // Leaky bucket cumulative rate limiter: max 3 injections per second
    const drain = (elapsed / 1000) * 2.0;
    this._kickInputBudget = Math.max(0, (this._kickInputBudget || 0) - drain);
    if (this._kickInputBudget >= 3.0) return false;
    this._kickInputBudget += 1.0;
    this._lastKickInputTime = now;

    // Conservative strength scaling: normalized kick onset amplitude mapped to [0.06, 0.20]
    const norm = Math.max(0.0, Math.min(1.0, Number(strength) || 1.0));
    const injectStrength = 0.06 + norm * 0.14;

    // Deterministic spatial distribution without modifying simulation seed
    this._kickInputIndex = (this._kickInputIndex || 0) + 1;
    const idx = this._kickInputIndex;
    const phi1 = 0.618033988749895;
    const phi2 = 0.414213562373095;
    const rFrac = Math.sqrt((idx * phi1) % 1.0);
    const theta = 2 * Math.PI * ((idx * phi2) % 1.0);
    const size = this.simulationSize;
    const center = size / 2;
    const maxR = size * 0.32;
    const targetX = Math.max(
      12,
      Math.min(size - 13, Math.round(center + maxR * rFrac * Math.cos(theta))),
    );
    const targetY = Math.max(
      12,
      Math.min(size - 13, Math.round(center + maxR * rFrac * Math.sin(theta))),
    );

    const patchRadius = 10;
    const rgb = hexToRgb(this._parameters.dyeColor || "#00f0ff");
    const lockBarrier = (this._parameters.barrierLock || "mask") === "mask";
    const disturbMode = "kick_color";

    this._runtime.disturb(targetX, targetY, patchRadius, disturbMode, {
      dyeColor: rgb,
      lockBarrier,
      strength: injectStrength,
    });

    if (norm > 0.8) {
      const satTheta = theta + Math.PI + 0.3;
      const satR = maxR * 0.5 * rFrac;
      const satX = Math.max(
        12,
        Math.min(size - 13, Math.round(center + satR * Math.cos(satTheta))),
      );
      const satY = Math.max(
        12,
        Math.min(size - 13, Math.round(center + satR * Math.sin(satTheta))),
      );
      this._runtime.disturb(satX, satY, 8, disturbMode, {
        dyeColor: rgb,
        lockBarrier,
        strength: injectStrength * 0.75,
      });
    }

    return true;
  }

  renderSnapshot(canvas, options = {}) {
    if (!this.ready)
      throw new Error(
        this.lastError || "Wait for Neural Growth to initialize.",
      );
    const manualPhaseRad =
      ((Number(this._parameters.palettePhase || 0) % 360) * Math.PI) / 180;
    const effectivePhaseRad =
      (manualPhaseRad + (this._palettePhaseAccumulator || 0)) % (Math.PI * 2);

    this._runRuntime(() =>
      this._runtime.draw(canvas, {
        palette: options.palette ?? this._parameters.palette,
        palettePhase:
          options.palettePhase !== undefined
            ? options.palettePhase
            : effectivePhaseRad,
        zoom: options.zoom ?? 1,
        displayFilter: options.displayFilter ?? this._parameters.displayFilter,
        showBarrier: options.showBarrier ?? false,
        ripples: options.ripples ?? [],
        dyeColor: options.dyeColor ?? this._parameters.dyeColor,
        channelView: options.channelView ?? this._parameters.channelView,
        echoDecay: options.echoDecay ?? this._parameters.echoDecay,
        echoDrift: options.echoDrift ?? this._parameters.echoDrift,
        echoMode: options.echoMode ?? this._parameters.echoMode,
        echoStyle: options.echoStyle ?? this._parameters.echoStyle,
      }),
    );
  }

  dispose() {
    this.cancel();
    this._disposed = true;
    this._dreamBridge?.dispose();
    this._runtime?.dispose();
    this._runtime = null;
    this._checkpoints.clear();
  }
}

export { AUDIO_PROFILES };
