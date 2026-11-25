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
import { AudioResponse, AUDIO_PRESETS } from "./neural-growth/audio-response.js";
import {
  ResonanceConfig,
  RESONANCE_PRESETS,
} from "./neural-growth/resonance-config.js";
const STILL_PAN = Object.freeze([0, 0]);

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
    this._audioResponse = new AudioResponse();
    this._palettePhaseAccumulator = 0.0;
    this._lastPaletteTime = null;
    this._capabilities = capabilities;
    this._parameters = sanitizeParameters(this);
    this.lastError = null;
    this._failedConfiguration = null;
  }

  get effectiveZoom() {
    return Number(this._parameters.zoom) || 1;
  }

  get effectivePan() { return STILL_PAN; }

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
    return this.controlsForParameters(this._parameters);
  }

  controlsForParameters() {
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
        help: "Requested updates per second, limited to three per frame. Zero freezes growth; CLOCK pauses without resetting.",
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
        min: -0.2,
        max: 0.2,
        step: 0.005,
        default: 0.0,
        help: "Dynamic angular drift rate injected into perception filter kernels across spatial gradients.",
      },
      {
        key: "resonanceFeedback",
        label: "STATE FEEDBACK",
        type: "range",
        min: 0.0,
        max: 0.95,
        step: 0.01,
        default: 0.0,
        help: "Temporal momentum and blending weight applied to non-RGB hidden channels (channels 4-11).",
      },
      {
        key: "resonanceNoise",
        label: "STOCHASTIC NOISE",
        type: "range",
        min: 0.0,
        max: 0.5,
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
        key: "audioPreset",
        label: "AUDIO PRESET",
        type: "select",
        default: "off",
        options: AUDIO_PRESETS.map(({ value, label }) => ({ value, label })),
        help: "Adds audio routes without changing base values, LFOs, or your own routes. Off removes only preset-owned routes.",
      },
      {
        key: "audioRippleAmount",
        label: "AUDIO RIPPLE",
        type: "range",
        min: 0,
        max: 1.5,
        step: 0.01,
        default: 0,
        help: "Optical ripple amplitude on accepted kicks. No cellular changes. Choose a source in MOD to follow audio.",
      },
      {
        key: "audioSporeAmount",
        label: "AUDIO SPORES",
        type: "range",
        min: 0,
        max: 0.08,
        step: 0.001,
        default: 0,
        help: "Gentle cellular color mixing on accepted kicks; yields to manual brushes. Total mixing stays below 0.08 per second.",
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
        Number(parameters?.echoDecay || 0) > 0.01)
    );
  }

  get isClockRunning() {
    return this._clockRunning;
  }

  setClockRunning(running) {
    if (!running) this.cancelAudio();
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
    this.cancelAudio();
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

  migrateStoredParameters(stored) {
    if (!stored || typeof stored !== "object") return stored;
    const next = { ...stored };
    // These keys never imply new routes or destinations. In particular the old
    // dynamic profile cannot opt a saved field into cellular audio injection.
    for (const key of [
      "audioProfile",
      "beatShockwave",
      "shockwaveIntensity",
      "acousticInjection",
      "acousticThreshold",
      "acousticPosition",
      "cameraBreathing",
      "cameraReactivity",
    ])
      delete next[key];
    return next;
  }

  normalizeStoredParameter(key, value) {
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
        return ((num % 360) + 360) % 360;
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
      key === "audioPreset" ||
      key === "audioRippleAmount" ||
      key === "audioSporeAmount" ||
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
    const sanitized = sanitizeParameters(this, parameters, { continuous: true });
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
        this._audioResponse.step(performance.now(), this.simulationSize,
          (...args) => this._runtime.disturb(...args), hexToRgb(parameters.dyeColor || "#00f0ff"));
        if (this._lastTick !== null) {
          const delta = Math.max(0, timeSeconds - this._lastTick);
          const speed = Math.max(0, Number(parameters.growthSpeed) || 0);
          this._accumulator += delta * speed;
          const maxStepsPerFrame = 3;
          const count = Math.min(
            maxStepsPerFrame,
            Math.floor(this._accumulator + 1e-9),
          );
          if (count > 0) {
            const angleRad =
              (Number(parameters.rotation || 0) * Math.PI) / 180;
            const twistRad =
              (Number(parameters.twist || 0) * Math.PI) / 180;
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
              foldCount: parameters.foldCount,
              latentMomentum: parameters.latentMomentum,
            });
            this._accumulator -= count;
          }
          const excessWholeSteps = Math.floor(this._accumulator);
          if (excessWholeSteps > 0) {
            this._accumulator -= excessWholeSteps;
          }
          this._accumulator = Math.max(0, this._accumulator);
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
      const effectiveZoom = parameters.zoom;
      this._runtime.draw(canvas, {
        palette: parameters.palette,
        palettePhase: effectivePhaseRad,
        zoom: effectiveZoom,
        pan: this.effectivePan,
        displayFilter: parameters.displayFilter,
        showBarrier,
        ripples: this._activeRipples || [],
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
        foldCount: this._parameters.foldCount,
        latentMomentum: this._parameters.latentMomentum,
      }),
    );
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
    this.cancelAudio();
    this._lastTick = null;
    this._accumulator = 0;
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
    this._audioResponse.interact(this._audioResponse.pointerDown, performance.now());
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
    const size = this.simulationSize;
    const wrappedDelta = (delta) => delta - Math.round(delta / size) * size;
    const wrap = (value) => ((Math.round(value) % size) + size) % size;
    const dx = wrappedDelta(x1 - x0);
    const dy = wrappedDelta(y1 - y0);
    const dist = Math.hypot(dx, dy);
    const strokeAngle = Math.atan2(dy, dx);
    const step = Math.max(1, radius * 0.5);
    const count = Math.min(32, Math.max(1, Math.ceil(dist / step)));
    for (let i = 0; i <= count; i += 1) {
      const t = count === 0 ? 0 : i / count;
      this.queueDisturbance(wrap(x0 + dx * t), wrap(y0 + dy * t), radius, mode, {
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

  cancelAudio() {
    this._audioResponse.cancel();
    this._activeRipples =
      this._activeRipples?.filter((r) => !r.automatic) || [];
  }

  notePointerInteraction(down, timestamp = performance.now()) {
    this._audioResponse.interact(down, timestamp);
  }

  onAudioFrame(levels, timestamp, parameters, enabled = true) {
    const event = this._audioResponse.update(
      levels,
      timestamp,
      parameters,
      enabled && this.ready && this._clockRunning,
    );
    if (!enabled || !levels?.hasSignal || !this._clockRunning)
      this.cancelAudio();
    if (event)
      this.triggerRipple(
        event.x * this.simulationSize,
        event.y * this.simulationSize,
        null,
        event.ripple,
        { automatic: true },
      );
  }

  triggerRipple(
    x,
    y,
    customRadius = null,
    maxAmplitude = null,
    { automatic = false } = {},
  ) {
    if (!this.ready) return false;
    const size = this.simulationSize;
    const coordinate = (value) =>
      Math.max(
        0,
        Math.min(
          size - 1,
          Math.round(
            Number.isFinite(Number(value)) && value !== null
              ? Number(value)
              : size / 2,
          ),
        ),
      );
    const radius =
      customRadius !== null && Number.isFinite(Number(customRadius))
        ? Math.max(0, Math.min(size / Math.sqrt(2), Number(customRadius)))
        : size / Math.sqrt(2);
    const amplitude =
      maxAmplitude !== null && Number.isFinite(Number(maxAmplitude))
        ? Math.max(0, Math.min(1.5, Number(maxAmplitude)))
        : Math.min(1.5, Math.max(0.8, radius * 0.015));
    this._activeRipples = this._activeRipples || [];
    // Automatic events never evict a manual ripple.
    if (this._activeRipples.length >= 4) {
      const audioIndex = this._activeRipples.findIndex((r) => r.automatic);
      if (automatic && audioIndex < 0) return false;
      this._activeRipples.splice(audioIndex >= 0 ? audioIndex : 0, 1);
    }
    this._activeRipples.push({
      x: coordinate(x),
      y: coordinate(y),
      radius,
      amplitude,
      automatic,
      startTime: performance.now(),
      duration: 0.55,
    });
    return true;
  }

  renderSnapshot(canvas, options = {}) {
    this.cancelAudio();
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
        zoom: options.zoom ?? this.effectiveZoom,
        pan: options.pan ?? this.effectivePan,
        preserveEchoHistory: true,
        displayFilter: options.displayFilter ?? this._parameters.displayFilter,
        showBarrier: options.showBarrier ?? false,
        ripples: options.ripples ?? [],
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
    this._runtime?.dispose();
    this._runtime = null;
    this._checkpoints.clear();
  }
}
