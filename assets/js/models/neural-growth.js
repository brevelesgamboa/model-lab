import { sanitizeParameters } from "../core/model-contract.js";
import { validateCheckpoint } from "./neural-growth/reference.js";
import { TextureNcaRuntime } from "./neural-growth/runtime.js";
import {
  DEFAULT_PATTERN,
  PATTERNS,
  getPattern,
} from "./neural-growth/patterns.js";

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
      savedRun: false,
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
    this._parameters = sanitizeParameters(this);
    this.lastError = null;
    this._failedConfiguration = null;
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
      },
      {
        key: "simulationSize",
        label: "SIMULATION GRID",
        type: "select",
        default: 128,
        options: [
          { value: 128, label: "128 × 128 · lighter" },
          { value: 256, label: "256 × 256 · more detail" },
        ],
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
        key: "brushRadius",
        label: "BRUSH RADIUS",
        type: "range",
        min: 4,
        max: 32,
        step: 1,
        default: 8,
        modulation: false,
        help: "Pointer disturbance brush radius in grid cells.",
      },
      {
        key: "disturbanceMode",
        label: "DISTURBANCE MODE",
        type: "select",
        default: "erase",
        options: [
          { value: "erase", label: "Erase · Neutral (0)" },
          { value: "noise", label: "Noise · Scramble" },
        ],
        help: "Interactive disturbance mode: zero channels to neutral or inject high-frequency noise.",
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
  get simulationSize() {
    return this._runtime?.size || this._parameters.simulationSize;
  }
  getStats() {
    return this._runtime?.getStats() || null;
  }
  isDynamic(parameters) {
    return (
      !this.lastError &&
      !this._loadingPattern &&
      !this._disposed &&
      this._clockRunning &&
      Number(parameters.growthSpeed) > 0
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
    this.setClockRunning(false);
  }

  waitForIdle() {
    return this._pending || Promise.resolve();
  }

  parameterDefaultsForChange(key, value) {
    if (key !== "pattern") return null;
    const startup = getPattern(value).startup;
    if (!startup) return null;
    return { seed: startup.seed, simulationSize: startup.gridSize };
  }

  onParameterChange(key, value) {
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
        candidate.draw(preview, parameters.palette);
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
      if (
        this._parameters.growthSpeed !== parameters.growthSpeed ||
        this._parameters.simulationSize !== parameters.simulationSize
      ) {
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
            this._runtime.step(count, {
              rotation: angleRad,
              topology: parameters.topology,
            });
          }
          this._accumulator -= count;
        }
        this._lastTick = timeSeconds;
      }
      this._runtime.draw(canvas, parameters.palette, parameters.zoom);
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
    const angleRad = (Number(this._parameters.rotation || 0) * Math.PI) / 180;
    this._runRuntime(() =>
      this._runtime.step(1, {
        rotation: angleRad,
        topology: this._parameters.topology,
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
    this._lastTick = null;
    this._accumulator = 0;
  }

  queueDisturbance(
    x,
    y,
    radius = Number(this._parameters.brushRadius) ||
      Math.max(2, Math.round(this.simulationSize * 0.06)),
    mode = this._parameters.disturbanceMode || "erase",
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
    if (this._queuedDisturbances.length >= 64) {
      this._queuedDisturbances.shift();
    }
    this._queuedDisturbances.push({
      x: clampedX,
      y: clampedY,
      radius: clampedRadius,
      mode,
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
  ) {
    if (!this.ready) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, radius * 0.5);
    const count = Math.min(32, Math.max(1, Math.ceil(dist / step)));
    for (let i = 0; i <= count; i += 1) {
      const t = count === 0 ? 0 : i / count;
      this.queueDisturbance(x0 + dx * t, y0 + dy * t, radius, mode);
    }
  }

  _drainDisturbances() {
    if (!this._runtime || this._queuedDisturbances.length === 0) return false;
    let applied = false;
    while (this._queuedDisturbances.length > 0) {
      const { x, y, radius, mode } = this._queuedDisturbances.shift();
      try {
        if (mode && mode !== "erase") {
          this._runtime.disturb(x, y, radius, mode);
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

  renderSnapshot(canvas) {
    if (!this.ready)
      throw new Error(
        this.lastError || "Wait for Neural Growth to initialize.",
      );
    this._runRuntime(() =>
      this._runtime.draw(canvas, this._parameters.palette, 1),
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
