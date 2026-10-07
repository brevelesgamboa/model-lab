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

function setup(context, { load = async () => checkpoint, failSize = 0 } = {}) {
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
        step(count) {
          this.steps += count;
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
  const params = defaultParameters(model);
  const canvas = { width: 128, height: 128 };
  context.after(() => model.dispose());
  return { model, params, canvas, runtimes };
}

test("Growth declares explicit capture and modulation capabilities", () => {
  const model = new NeuralGrowthModel();
  validateModelDefinition(model);
  assert.equal(model.supportsModulation, false);
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

test("redraws, palette, speed, viewport and snapshots do not reset or advance state", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);
  model.step();
  model.disturb(12, 34);
  model.setClockRunning(true);
  await model.render(
    canvas,
    { ...params, palette: "spectral", growthSpeed: 60 },
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
  model.onParameterChange("pattern", DEFAULT_PATTERN);
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
