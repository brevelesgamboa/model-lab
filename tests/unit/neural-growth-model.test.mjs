import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";
import {
  PATTERNS,
  DEFAULT_PATTERN,
  getPattern,
} from "../../assets/js/models/neural-growth/patterns.js";
import {
  captureCapabilities,
  defaultParameters,
  validateModelDefinition,
} from "../../assets/js/core/model-contract.js";

const checkpoint = JSON.parse(
  await readFile(
    new URL("../../models/neural-growth/checkpoint.json", import.meta.url),
    "utf8",
  ),
);

function setup(context, { load = async () => checkpoint, failSize = 0, initialSize = 128 } = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0 }) };
  context.after(() => {
    globalThis.document = previousDocument;
  });
  const runtimes = [];
  const model = new NeuralGrowthModel({
    load,
    createRuntime: ({ size, seed }) => {
      if (size === failSize) throw new Error("Allocation failed");
      const runtime = {
        size,
        seed,
        steps: 0,
        restarts: 0,
        draws: 0,
        disturbances: [],
        disposed: false,
        step(count, options) {
          this.steps += count;
          this.lastStepOptions = options;
        },
        draw(canvas) {
          this.draws += 1;
          canvas.paintedBy = this;
        },
        restart(value) {
          this.seed = value;
          this.steps = 0;
          this.restarts += 1;
        },
        disturb(...values) {
          this.disturbances.push(values);
        },
        clearBarrier() {
          this.barrierCleared = true;
        },
        dispose() {
          this.disposed = true;
        },
        getStats() {
          return {
            size: this.size,
            seed: this.seed,
            steps: this.steps,
            resources: { bytes: 123 },
          };
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  const params = { ...defaultParameters(model), simulationSize: initialSize };
  const canvas = { width: 128, height: 128 };
  context.after(() => model.dispose());
  return { model, params, canvas, runtimes };
}

test("Growth declares explicit capture and modulation capabilities", () => {
  const model = new NeuralGrowthModel();
  validateModelDefinition(model);
  assert.equal(model.supportsModulation, true);
  assert.deepEqual(captureCapabilities(model), {
    png: true,
    gif: false,
    highResolution: false,
    savedRun: false,
  });
  assert.deepEqual(captureCapabilities({}), {
    png: true,
    gif: true,
    highResolution: true,
    savedRun: true,
  });
  assert.deepEqual(captureCapabilities({ usesInternalClock: true }), {
    png: true,
    gif: false,
    highResolution: true,
    savedRun: false,
  });
  assert.throws(
    () =>
      validateModelDefinition({
        ...model,
        controls: [],
        render() {},
        captureCapabilities: { gif: "false" },
      }),
    /Invalid capture/,
  );
});

test("redraws, palette, shading, speed, rotation, topology, zoom, viewport and snapshots do not reset or advance state", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);
  model.step();
  model.disturb(12, 34);
  model.setClockRunning(true);
  await model.render(
    canvas,
    {
      ...params,
      palette: "spectral",
      shading: "gloss",
      reliefStrength: 2.0,
      lightAngle: 120,
      displayFilter: "crisp",
      coordinateTransform: "spiral",
      twist: 45,
      growthSpeed: 60,
      rotation: 180,
      topology: "hexagonal",
      zoom: 2,
    },
    100,
  );
  canvas.width = 512;
  await model.render(canvas, params, 200);
  model.renderSnapshot({});
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].steps, 1);
  assert.equal(runtimes[0].restarts, 0);
  assert.deepEqual(runtimes[0].disturbances, [[12, 34, 8]]);
});

test("default simulation size is 256 and pattern switching preserves simulation size", async () => {
  const model = new NeuralGrowthModel();
  const defaults = defaultParameters(model);
  assert.equal(defaults.simulationSize, 256);
  assert.equal(defaults.shading, "relief");
  assert.equal(defaults.reliefStrength, 1.2);
  assert.equal(defaults.lightAngle, 45);
  assert.equal(defaults.displayFilter, "smooth");
  assert.equal(defaults.coordinateTransform, "cartesian");
  assert.equal(defaults.twist, 0);
  assert.equal(defaults.disturbanceMode, "erase");
  assert.equal(defaults.dyeColor, "#00f0ff");
  assert.equal(defaults.barrierLock, "mask");

  // Pattern change should only default seed, NOT override simulationSize
  const patternDefaults = model.parameterDefaultsForChange("pattern", "bumpy-surface");
  assert.ok(patternDefaults);
  assert.equal(patternDefaults.simulationSize, undefined);
  assert.equal(typeof patternDefaults.seed, "number");
  assert.equal(patternDefaults.seed, 42);
});

test("coordinateTransform suggests smart defaults and forwards to runtime steps", async (context) => {
  const model = new NeuralGrowthModel();
  assert.deepEqual(model.parameterDefaultsForChange("coordinateTransform", "spiral"), { twist: 35 });
  assert.deepEqual(model.parameterDefaultsForChange("coordinateTransform", "vortex"), { twist: 0 });
  assert.deepEqual(model.parameterDefaultsForChange("coordinateTransform", "julia"), { twist: 0 });
  assert.deepEqual(model.parameterDefaultsForChange("coordinateTransform", "dipole"), { twist: 0 });
  assert.deepEqual(model.parameterDefaultsForChange("coordinateTransform", "cartesian"), { twist: 0 });
  assert.equal(model.onParameterChange("coordinateTransform", "spiral"), true);

  const { model: runModel, params, canvas, runtimes } = setup(context);
  await runModel.render(canvas, { ...params, coordinateTransform: "julia", twist: 30, rotation: 90 }, 0);
  runModel.step();
  assert.equal(runtimes[0].steps, 1);
  assert.equal(runtimes[0].lastStepOptions.coordinateTransform, "julia");
  assert.ok(Math.abs(runtimes[0].lastStepOptions.twist - (30 * Math.PI) / 180) < 1e-6);
  assert.ok(Math.abs(runtimes[0].lastStepOptions.rotation - (90 * Math.PI) / 180) < 1e-6);
});

test("queueDisturbance and queueDisturbanceStroke bound queue depth and interpolate continuous strokes", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);

  model.queueDisturbance(10, 20, 6);
  assert.equal(runtimes[0].disturbances.length, 0);

  await model.render(canvas, params, 1);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.deepEqual(runtimes[0].disturbances[0], [10, 20, 6]);

  runtimes[0].disturbances.length = 0;
  model.queueDisturbanceStroke(10, 10, 10, 30, 4);
  assert.equal(runtimes[0].disturbances.length, 0);
  await model.render(canvas, params, 2);
  assert.ok(runtimes[0].disturbances.length >= 5);
  assert.deepEqual(runtimes[0].disturbances[0], [10, 10, 4]);
  assert.deepEqual(
    runtimes[0].disturbances[runtimes[0].disturbances.length - 1],
    [10, 30, 4],
  );

  runtimes[0].disturbances.length = 0;
  for (let i = 0; i < 100; i += 1) {
    model.queueDisturbance(i, i, 4);
  }
  await model.render(canvas, params, 3);
  assert.equal(runtimes[0].disturbances.length, 64);
  assert.deepEqual(runtimes[0].disturbances[63], [99, 99, 4]);
});

test("interactive brushes dispatch chromophore, shockwave, stasis freeze/thaw and flow grooming", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, { ...params, disturbanceMode: "dye", dyeColor: "#ff00a0" }, 0);
  model.queueDisturbance(15, 25, 8, "dye", { dyeColor: "#ff00a0" });
  await model.render(canvas, { ...params, disturbanceMode: "dye", dyeColor: "#ff00a0" }, 1);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.equal(runtimes[0].disturbances[0][0], 15);
  assert.equal(runtimes[0].disturbances[0][1], 25);
  assert.equal(runtimes[0].disturbances[0][2], 8);
  assert.equal(runtimes[0].disturbances[0][3], "dye");
  assert.deepEqual(runtimes[0].disturbances[0][4], { dyeColor: [1, 0, 160 / 255], strokeAngle: 0, lockBarrier: true });

  runtimes[0].disturbances.length = 0;
  await model.render(canvas, { ...params, disturbanceMode: "dye", dyeColor: "#ff00a0", barrierLock: "draw" }, 2);
  model.queueDisturbance(15, 25, 8, "dye", { dyeColor: "#ff00a0" });
  await model.render(canvas, { ...params, disturbanceMode: "dye", dyeColor: "#ff00a0", barrierLock: "draw" }, 3);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.equal(runtimes[0].disturbances[0][4].lockBarrier, false);

  runtimes[0].disturbances.length = 0;
  await model.render(canvas, { ...params, disturbanceMode: "shockwave" }, 4);
  model.queueDisturbance(30, 40, 12, "shockwave");
  await model.render(canvas, { ...params, disturbanceMode: "shockwave" }, 5);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.equal(runtimes[0].disturbances[0][3], "shockwave");

  runtimes[0].disturbances.length = 0;
  await model.render(canvas, { ...params, disturbanceMode: "freeze" }, 6);
  model.queueDisturbance(50, 50, 6, "freeze");
  await model.render(canvas, { ...params, disturbanceMode: "freeze" }, 7);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.equal(runtimes[0].disturbances[0][3], "freeze");

  runtimes[0].disturbances.length = 0;
  await model.render(canvas, { ...params, disturbanceMode: "thaw" }, 8);
  model.queueDisturbance(50, 50, 6, "thaw");
  await model.render(canvas, { ...params, disturbanceMode: "thaw" }, 9);
  assert.equal(runtimes[0].disturbances.length, 1);
  assert.equal(runtimes[0].disturbances[0][3], "thaw");

  runtimes[0].disturbances.length = 0;
  await model.render(canvas, { ...params, disturbanceMode: "groom" }, 10);
  model.queueDisturbanceStroke(10, 10, 20, 10, 4, "groom");
  await model.render(canvas, { ...params, disturbanceMode: "groom" }, 11);
  assert.ok(runtimes[0].disturbances.length > 0);
  assert.equal(runtimes[0].disturbances[0][3], "groom");
  assert.equal(runtimes[0].disturbances[0][4].strokeAngle, 0);

  model.clearBarrier();
  assert.equal(runtimes[0].barrierCleared, true);
});

test("seed resets once, grid replacement disposes once, and model switching retains state", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);
  model.step();
  const seeded = { ...params, seed: 42 };
  await model.render(canvas, seeded, 0);
  await model.render(canvas, seeded, 0);
  assert.equal(runtimes[0].restarts, 1);
  const larger = { ...seeded, simulationSize: 256 };
  await model.render(canvas, larger, 0);
  await model.render(canvas, larger, 0);
  assert.equal(runtimes.length, 2);
  assert.equal(runtimes[0].disposed, true);
  model.step();
  model.cancel();
  await model.render(canvas, larger, 0);
  assert.equal(runtimes[1].steps, 1);
  assert.equal(runtimes[1].restarts, 0);
});

test("only live ticks advance, pause rebases, and catch-up is bounded", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  const live = { advanceSimulation: true };
  await model.render(canvas, params, 0);
  model.setClockRunning(true);
  await model.render(canvas, params, 0, live);
  await model.render(canvas, params, 1 / 30, live);
  assert.equal(runtimes[0].steps, 1);
  await model.render(canvas, params, 20, live);
  assert.ok(runtimes[0].steps <= 3);
  const before = runtimes[0].steps;
  model.setClockRunning(false);
  await model.render(canvas, params, 50, live);
  model.setClockRunning(true);
  await model.render(canvas, params, 100, live);
  assert.equal(runtimes[0].steps, before);
  await model.render(canvas, params, 100 + 1 / 30, live);
  assert.equal(runtimes[0].steps, before + 1);
});

test("failed initialization is latched until explicit retry; stale loads cannot paint", async (context) => {
  let loads = 0;
  const { model, params, canvas } = setup(context, {
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error("Download failed");
      return checkpoint;
    },
  });
  await model.render(canvas, params, 0);
  await model.render(canvas, params, 1);
  assert.equal(loads, 1);
  assert.equal(canvas.paintedBy, undefined);
  assert.equal(model.isDynamic(params), false);
  model.restart();
  await model.render(canvas, params, 2);
  assert.equal(model.ready, true);
  assert.equal(loads, 2);
});

test("cancel during asynchronous loading cannot allocate or overwrite another route", async (context) => {
  let finish;
  const { model, params, canvas, runtimes } = setup(context, {
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = model.render(canvas, params, 0);
  model.cancel();
  canvas.otherRoute = true;
  finish(checkpoint);
  assert.equal(await pending, null);
  assert.equal(runtimes.length, 0);
  assert.equal(canvas.paintedBy, undefined);
});

test("failed grid allocation retains the old state and does not loop", async (context) => {
  const { model, params, canvas, runtimes } = setup(context, { failSize: 256 });
  await model.render(canvas, params, 0);
  model.step();
  const larger = { ...params, simulationSize: 256 };
  await model.render(canvas, larger, 0);
  await model.render(canvas, larger, 0);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].disposed, false);
  assert.equal(runtimes[0].steps, 1);
  assert.equal(canvas.paintedBy, runtimes[0]);
  assert.equal(model.lastError, "Allocation failed");
});

test("explicit retry replaces a failed runtime, including lost contexts", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);
  runtimes[0].draw = () => {
    throw new Error("Context lost");
  };
  runtimes[0].getStats = () => ({
    size: 128,
    steps: 0,
    contextLost: true,
    resources: { bytes: 123 },
  });
  await model.render(canvas, params, 1);
  assert.equal(model.lastError, "Context lost");
  model.restart();
  await model.render(canvas, params, 2);
  assert.equal(model.ready, true);
  assert.equal(runtimes.length, 2);
  assert.equal(runtimes[0].disposed, true);
});

// Adapter-only fixture. Actual release files are independently read and
// fingerprinted in neural-growth.test.mjs; these weights are never distributed.
const originalFixture = () => ({
  ...checkpoint,
  id: "membrane-field",
  name: "Membrane Field",
});

test("pattern catalog binds distinct validated files and rejects unknown IDs", () => {
  const model = new NeuralGrowthModel();
  const control = model.controls.find(({ key }) => key === "pattern");
  assert.equal(control.default, DEFAULT_PATTERN);
  assert.equal(new Set(PATTERNS.map(({ id }) => id)).size, PATTERNS.length);
  assert.equal(
    new Set(PATTERNS.map(({ checkpointUrl }) => checkpointUrl.href)).size,
    PATTERNS.length,
  );
  assert.match(getPattern(DEFAULT_PATTERN).technicalInfo.license, /CC-BY/);
  assert.match(
    getPattern("membrane-field").technicalInfo.title,
    /Organic Structures/,
  );
  assert.throws(() => getPattern("../checkpoint"), /Unknown/);
});

test("pattern replacement commits once, updates metadata, and caches weights lazily", async (context) => {
  const loads = [];
  const { model, params, canvas, runtimes } = setup(context, {
    load: async (_signal, pattern) => {
      loads.push(pattern.id);
      return pattern.id === DEFAULT_PATTERN ? checkpoint : originalFixture();
    },
  });
  await model.render(canvas, params, 0);
  model.step();
  const original = { ...params, pattern: "membrane-field" };
  await model.render(canvas, original, 100);
  await model.render(canvas, original, 101);
  assert.equal(runtimes.length, 2);
  assert.equal(runtimes[0].disposed, true);
  assert.equal(runtimes[1].steps, 0);
  assert.equal(model.activePattern, "membrane-field");
  assert.match(model.technicalInfo.title, /Membrane Field/);
  await model.render(canvas, params, 102);
  assert.equal(runtimes[1].disposed, true);
  assert.deepEqual(loads, [DEFAULT_PATTERN, "membrane-field"]);
  assert.match(model.technicalInfo.title, /Vesicle Study/);
});

test("failed pattern loads retain old state and metadata; returning to it never resets", async (context) => {
  let loads = 0;
  const { model, params, canvas, runtimes } = setup(context, {
    load: async (_signal, pattern) => {
      loads += 1;
      if (pattern.id !== DEFAULT_PATTERN)
        throw new Error("Pattern unavailable");
      return checkpoint;
    },
  });
  await model.render(canvas, params, 0);
  model.step();
  const original = { ...params, pattern: "membrane-field" };
  await model.render(canvas, original, 1);
  await model.render(canvas, original, 2);
  assert.equal(loads, 2);
  assert.equal(canvas.paintedBy, runtimes[0]);
  assert.equal(runtimes[0].disposed, false);
  assert.equal(model.activePattern, DEFAULT_PATTERN);
  await model.render(canvas, params, 3);
  assert.equal(model.ready, true);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].steps, 1);
  assert.equal(runtimes[0].restarts, 0);
});

test("superseded pattern loads cannot allocate, reset or paint the retained field", async (context) => {
  let finish;
  let signal;
  const { model, params, canvas, runtimes } = setup(context, {
    load: async (abort, pattern) => {
      if (pattern.id === DEFAULT_PATTERN) return checkpoint;
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await model.render(canvas, params, 0);
  model.step();
  const pending = model.render(
    canvas,
    { ...params, pattern: "membrane-field" },
    1,
  );
  assert.equal(model.ready, false);
  assert.match(model.technicalInfo.title, /Vesicle Study/);
  assert.equal(model.onParameterChange("pattern", DEFAULT_PATTERN), true);
  assert.equal(model.onParameterChange("pattern", DEFAULT_PATTERN), false);
  assert.equal(signal.aborted, true);
  finish(originalFixture());
  assert.equal(await pending, null);
  await model.render(canvas, params, 2);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].steps, 1);
  assert.equal(runtimes[0].disposed, false);
});

test("wrong checkpoint identity cannot be presented as an original pattern", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);
  await model.render(canvas, { ...params, pattern: "membrane-field" }, 1);
  assert.match(model.lastError, /does not match/);
  assert.equal(model.activePattern, DEFAULT_PATTERN);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].disposed, false);
});
