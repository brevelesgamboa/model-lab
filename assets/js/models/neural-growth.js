import { sanitizeParameters } from "../core/model-contract.js";
import { validateCheckpoint } from "./neural-growth/reference.js";
import { TextureNcaRuntime } from "./neural-growth/runtime.js";

const checkpointUrl = new URL(
  "../../../models/neural-growth/checkpoint.json",
  import.meta.url,
);

async function loadCheckpoint(signal) {
  const response = await fetch(checkpointUrl, { signal });
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
      "Vesicle Study: a learned local update rule grows membrane-like textures across a persistent cellular grid. Disturb the field to observe regeneration.";
    this.available = true;
    this.supportsModulation = false;
    this.supportsRandomize = false;
    this.statefulSimulation = true;
    this.captureCapabilities = {
      png: true,
      gif: false,
      highResolution: false,
      savedRun: false,
    };
    this.technicalInfo = {
      title: "Vesicle Study · mixed4c_439",
      architecture:
        "12 state channels → 48 fixed-filter features → 96 ReLU units → 12 state deltas",
      objective:
        "Published Inception v1 mixed4c channel 439 activation target (training only)",
      inferenceFramework: "Native WebGL2 · quantized RGBA8",
      inferenceBackend: "WebGL2 required; half the cells update each step",
      browserInput: "Seeded update schedule; toroidal 128² or 256² grid",
      browserOutput: "RGB state projection; spectral palette is display-only",
      reference:
        "Niklasson, Mordvintsev, Randazzo & Levin · Self-Organising Textures (2021)",
      license: "Checkpoint: CC-BY-4.0 · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/NOTICE.md",
    };
    this._load = load;
    this._createRuntime = createRuntime;
    this._checkpoint = null;
    this._runtime = null;
    this._needsRuntime = false;
    this._pending = null;
    this._abort = null;
    this._epoch = 0;
    this._disposed = false;
    this._clockRunning = false;
    this._lastTick = null;
    this._accumulator = 0;
    this._parameters = sanitizeParameters(this);
    this.lastError = null;
    this._failedConfiguration = null;
  }

  get controls() {
    return [
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
        modulation: false,
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
      !this._needsRuntime &&
      !this.lastError &&
      !this._disposed,
    );
  }
  get state() {
    return this.lastError ? "ERROR" : this.ready ? "READY" : "LOADING";
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
      !this._disposed &&
      this._clockRunning &&
      Number(parameters.growthSpeed) > 0
    );
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
    this.setClockRunning(false);
  }

  waitForIdle() {
    return this._pending || Promise.resolve();
  }

  render(canvas, parameters, timeSeconds, { advanceSimulation = false } = {}) {
    const epoch = this._epoch;
    const task = this._render(
      canvas,
      sanitizeParameters(this, parameters),
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
    const configuration = `${parameters.simulationSize}:${parameters.seed}`;
    let candidate = null;
    try {
      if (this.lastError && configuration === this._failedConfiguration) {
        // Redraw the retained state after viewport resizing, if its context is
        // still usable. Never allocate or restart automatically after failure.
        if (this._runtime && !this._runtime.getStats().contextLost)
          this._runtime.draw(canvas, this._parameters.palette);
        return this._result();
      }
      if (!this._checkpoint) {
        const abort = new AbortController();
        this._abort = abort;
        const raw = await this._load(abort.signal);
        if (epoch !== this._epoch || this._disposed) return null;
        this._checkpoint = validateCheckpoint(raw);
        if (this._abort === abort) this._abort = null;
      }
      if (epoch !== this._epoch || this._disposed) return null;
      if (
        !this._runtime ||
        this._runtime.size !== parameters.simulationSize ||
        this._needsRuntime ||
        this.lastError
      ) {
        // Build and draw privately before committing. Failed grid changes retain
        // the old state and displayed frame instead of repeatedly clearing them.
        candidate = this._createRuntime({
          model: this._checkpoint,
          size: parameters.simulationSize,
          seed: parameters.seed,
        });
        const preview = document.createElement("canvas");
        preview.width = canvas.width;
        preview.height = canvas.height;
        candidate.draw(preview, parameters.palette);
        this._runtime?.dispose();
        this._runtime = candidate;
        this._needsRuntime = false;
        candidate = null;
      } else if (this._runtime.seed !== parameters.seed) {
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
          if (count) this._runtime.step(count);
          this._accumulator -= count;
        }
        this._lastTick = timeSeconds;
      }
      this._runtime.draw(canvas, parameters.palette);
      return this._result();
    } catch (error) {
      candidate?.dispose();
      if (epoch !== this._epoch || this._disposed) return null;
      this._fail(error, configuration);
      return this._result();
    }
  }

  _fail(
    error,
    configuration = `${this._parameters.simulationSize}:${this._parameters.seed}`,
  ) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this._failedConfiguration = configuration;
    this._needsRuntime = true;
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
      },
    };
  }

  step() {
    if (!this.ready) return;
    this._runRuntime(() => this._runtime.step(1));
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
    this._lastTick = null;
    this._accumulator = 0;
  }

  disturb(x, y, radius = Math.max(2, Math.round(this.simulationSize * 0.06))) {
    if (this.ready) this._runRuntime(() => this._runtime.disturb(x, y, radius));
  }

  renderSnapshot(canvas) {
    if (!this.ready)
      throw new Error(
        this.lastError || "Wait for Neural Growth to initialize.",
      );
    this._runRuntime(() =>
      this._runtime.draw(canvas, this._parameters.palette),
    );
  }

  dispose() {
    this.cancel();
    this._disposed = true;
    this._runtime?.dispose();
    this._runtime = null;
    this._checkpoint = null;
  }
}
