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

async function loadCheckpoint(signal, pattern) {
  const response = await fetch(pattern.checkpointUrl, { signal });
  if (!response.ok)
    throw new Error(`Checkpoint request failed (${response.status}).`);
  return response.json();
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
      highResolution: false,
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
    this._capabilities = capabilities;
    this._parameters = sanitizeParameters(this);
    this.lastError = null;
    this._failedConfiguration = null;
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
        help: "Transforms local perception vector fields: concentric rings, logarithmic spirals, or Julia fractal dendrites.",
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
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "center", label: "Center · Audio" },
          { value: "pointer", label: "Pointer · Draw" },
        ],
        help: "Shockwave ripple mode: audio kick-triggered at center, or drawing-triggered at pointer.",
      },
      {
        key: "shockwaveReach",
        label: "SHOCKWAVE REACH",
        type: "select",
        default: "canvas",
        options: [
          { value: "canvas", label: "Whole Canvas" },
          { value: "brush", label: "Follow Brush" },
        ],
        help: "Shockwave coverage range: expand across the entire canvas or follow current brush radius.",
      },
      {
        key: "shockwaveStyle",
        label: "SHOCKWAVE STYLE",
        type: "select",
        default: "refract",
        options: [
          { value: "refract", label: "Water Ripple · Clear Refraction" },
          { value: "chromatic", label: "Prism Split · Rainbow Aberration" },
          { value: "glow", label: "Neon Halo · Radiant Energy Ring" },
          { value: "harmonic", label: "Cymatic Echo · Concentric Double Wave" },
        ],
        help: "Wavefront appearance: clear water ripple, prism chromatic split, radiant neon halo, or concentric cymatic double wave.",
      },
      {
        key: "shockwaveImpact",
        label: "SHOCKWAVE IMPACT",
        type: "select",
        default: "color",
        options: [
          { value: "color", label: "Color Blend · Auto Standout" },
          { value: "none", label: "Visual Only · Optical Lens" },
        ],
        help: "Cellular effect on shockwave: gently infuses high-contrast pigment that cells weave into the living pattern, or pure optical wave.",
      },
      {
        key: "brushRadius",
        label: "BRUSH RADIUS",
        type: "range",
        min: 4,
        max: 96,
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
        help: "Interactive brush: Erase, Noise, Color, Invert, Ripple, Freeze barrier, Unfreeze barrier, or Flow direction.",
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
          { value: "native", label: "Native RGB" },
          { value: "spectral", label: "Spectral" },
        ],
        help: "Display mapping only; does not alter the learned state or update rule.",
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
        key: "shading",
        label: "3D SHADING",
        type: "select",
        default: "relief",
        options: [
          { value: "relief", label: "Relief · Diffuse 3D" },
          { value: "gloss", label: "Gloss · Specular Sheen" },
          { value: "flat", label: "Flat · Unshaded 2D" },
          { value: "normals", label: "Normals · Vector Map" },
        ],
        help: "Real-time surface gradient shading computed from cell state differentials in WebGL2.",
      },
      {
        key: "reliefStrength",
        label: "RELIEF DEPTH",
        type: "range",
        min: 0,
        max: 3,
        step: 0.1,
        default: 1.2,
        help: "Height gradient multiplier for directional diffuse and specular relief shading.",
      },
      {
        key: "lightAngle",
        label: "LIGHT ANGLE",
        type: "range",
        min: 0,
        max: 360,
        step: 1,
        default: 45,
        wrap: true,
        help: "Directional light source angle in degrees. Wraps circularly and supports audio/LFO modulation.",
      },
      {
        key: "displayFilter",
        label: "DISPLAY FILTER",
        type: "select",
        default: "smooth",
        options: [
          {
            value: "smooth",
            label: "Smooth · Continuous High-DPI",
            compute: "neutral",
            guidance: "Sub-pixel continuous lighting, sharp normals, and pin-sharp specular highlights.",
          },
          {
            value: "crisp",
            label: "Crisp · Pixel Grid",
            compute: "efficient",
            guidance: "Discrete nearest-neighbor cell squares.",
          },
        ],
        help: "Viewport rendering fidelity: Smooth continuous sub-pixel shading or crisp pixel grid.",
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
        this.hasActiveRipples)
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
        value === "julia" ||
        value === "dipole" ||
        value === "cartesian"
      ) {
        return { twist: 0 };
      }
    }
    if (key === "beatShockwave" && value === "pointer") {
      return { disturbanceMode: "shockwave" };
    }
    return null;
  }

  normalizeStoredParameter(key, value) {
    if (key === "audioProfile") {
      if (value === "ambient" || value === "rhythm") {
        return "custom";
      }
    }
    if (key === "shockwaveImpact") {
      if (value !== "none" && value !== "color") {
        return "color";
      }
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
    return value;
  }

  onParameterChange(key, value) {
    if (this._parameters && key in this._parameters) {
      this._parameters[key] = value;
    }
    if (
      key === "coordinateTransform" ||
      key === "barrierLock" ||
      key === "audioProfile" ||
      key === "beatShockwave" ||
      key === "shockwaveReach" ||
      key === "shockwaveStyle" ||
      key === "shockwaveImpact" ||
      key === "channelView" ||
      key === "displayFilter"
    )
      return true;
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
        const preview = document.createElement("canvas");
        preview.width = canvas.width;
        preview.height = canvas.height;
        candidate.draw(preview, {
          palette: parameters.palette,
          zoom: parameters.zoom,
          shading: parameters.shading,
          reliefStrength: parameters.reliefStrength,
          lightAngle: parameters.lightAngle,
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
            this._runtime.step(count, {
              rotation: angleRad,
              topology: parameters.topology,
              coordinateTransform: parameters.coordinateTransform,
              twist: twistRad,
            });
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
      this._runtime.draw(canvas, {
        palette: parameters.palette,
        zoom: parameters.zoom,
        shading: parameters.shading,
        reliefStrength: parameters.reliefStrength,
        lightAngle: parameters.lightAngle,
        displayFilter: parameters.displayFilter,
        showBarrier,
        ripples: this._activeRipples || [],
        shockwaveStyle: parameters.shockwaveStyle,
        dyeColor: parameters.dyeColor,
        channelView: parameters.channelView,
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
    this._lastKickInputTime = 0;
    this._kickInputBudget = 0;
    this._kickInputIndex = 0;
    this._lastTick = null;
    this._accumulator = 0;
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
      const { x, y, radius, mode, dyeColor, strokeAngle } =
        this._queuedDisturbances.shift();
      try {
        const rgb = hexToRgb(dyeColor || this._parameters.dyeColor || "#00f0ff");
        if (mode && mode !== "erase") {
          const opts = {
            dyeColor: rgb,
            strokeAngle: strokeAngle || 0,
            lockBarrier,
          };
          if (mode === "shockwave") {
            opts.shockwaveImpact = this._parameters.shockwaveImpact || "color";
            opts.ringRadius = Math.max(6, Math.round(radius * 0.12));
            opts.ringWidth = Math.max(6, Math.min(24, radius * 0.1));
            opts.strength = 1.0;
          }
          this._runtime.disturb(x, y, radius, mode, opts);
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
    const reach = this._parameters?.shockwaveReach || "canvas";
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
      Number(maxAmplitude) ||
      Math.min(1.5, Math.max(0.8, radius * 0.015));
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
    const size = this.simulationSize;
    let x = Math.floor(size / 2);
    let y = Math.floor(size / 2);
    if (
      mode === "pointer" &&
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y)
    ) {
      x = coords.x;
      y = coords.y;
    }
    const reach = this._parameters?.shockwaveReach || "canvas";
    let radius = 16;
    if (reach === "canvas") {
      const d1 = Math.hypot(x, y);
      const d2 = Math.hypot(size - x, y);
      const d3 = Math.hypot(x, size - y);
      const d4 = Math.hypot(size - x, size - y);
      radius = Math.ceil(Math.max(d1, d2, d3, d4));
    } else {
      const chosen =
        Number(customRadius || this._parameters?.brushRadius) ||
        Math.round(size * 0.15);
      radius = Math.max(
        8,
        Math.min(Math.floor(size / 2), Math.round(chosen)),
      );
    }
    this.queueDisturbance(x, y, radius, "shockwave");
    return true;
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

  renderSnapshot(canvas) {
    if (!this.ready)
      throw new Error(
        this.lastError || "Wait for Neural Growth to initialize.",
      );
    this._runRuntime(() =>
      this._runtime.draw(canvas, {
        palette: this._parameters.palette,
        zoom: 1,
        shading: this._parameters.shading,
        reliefStrength: this._parameters.reliefStrength,
        lightAngle: this._parameters.lightAngle,
        displayFilter: this._parameters.displayFilter,
        showBarrier: false,
        ripples: [],
        shockwaveStyle: this._parameters.shockwaveStyle,
        dyeColor: this._parameters.dyeColor,
        channelView: this._parameters.channelView,
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

export { AUDIO_PROFILES };
