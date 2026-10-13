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
import {
  detectAudioProfile,
} from "../../assets/js/models/neural-growth/audio-profiles.js";

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
        draw(canvas, options) {
          this.draws += 1;
          this.lastDrawOptions = options;
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
    savedRun: true,
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

test("audio-reactive profiles and beat shockwaves map routes and dispatch kick disturbances", async (context) => {
  const { model, params, canvas, runtimes } = setup(context);
  await model.render(canvas, params, 0);

  const profileControl = model.controls.find((c) => c.key === "audioProfile");
  assert.ok(profileControl);
  assert.equal(profileControl.default, "off");
  assert.deepEqual(
    profileControl.options.map((o) => o.value),
    ["off", "subtle", "continuous", "dynamic", "custom"],
  );
  assert.deepEqual(
    profileControl.options.map((o) => o.label),
    ["Off", "Subtle", "Continuous", "Dynamic", "Custom"],
  );

  const reachControl = model.controls.find((c) => c.key === "shockwaveReach");
  assert.ok(reachControl);
  assert.equal(reachControl.default, "canvas");
  assert.deepEqual(
    reachControl.options.map((o) => o.value),
    ["canvas", "brush"],
  );

  const shockwaveControl = model.controls.find((c) => c.key === "beatShockwave");
  assert.ok(shockwaveControl);
  assert.equal(shockwaveControl.default, "off");
  assert.deepEqual(
    shockwaveControl.options.map((o) => o.value),
    ["off", "center", "pointer"],
  );

  const styleControl = model.controls.find((c) => c.key === "shockwaveStyle");
  assert.ok(styleControl);
  assert.equal(styleControl.default, "refract");
  assert.deepEqual(
    styleControl.options.map((o) => o.value),
    ["refract", "chromatic", "glow", "harmonic"],
  );
  assert.deepEqual(
    styleControl.options.map((o) => o.label),
    [
      "Water Ripple · Clear Refraction",
      "Prism Split · Rainbow Aberration",
      "Neon Halo · Radiant Energy Ring",
      "Cymatic Echo · Concentric Double Wave",
    ],
  );

  const impactControl = model.controls.find((c) => c.key === "shockwaveImpact");
  assert.ok(impactControl);
  assert.equal(impactControl.default, "color");
  assert.deepEqual(
    impactControl.options.map((o) => o.value),
    ["color", "none"],
  );
  assert.deepEqual(
    impactControl.options.map((o) => o.label),
    ["Color Blend · Auto Standout", "Visual Only · Optical Lens"],
  );

  const kickInputControl = model.controls.find((c) => c.key === "kickInputMode");
  assert.equal(kickInputControl, undefined);

  const channelControl = model.controls.find((c) => c.key === "channelView");
  assert.ok(channelControl);
  assert.equal(channelControl.default, "phenotype");
  assert.deepEqual(
    channelControl.options.map((o) => o.value),
    [
      "phenotype",
      "vitality",
      "fast_signals",
      "memory_waves",
      "energy_heat",
      "xray",
    ],
  );

  assert.equal(model.parameterDefaultsForChange("audioProfile", "continuous"), null);
  assert.equal(model.parameterDefaultsForChange("audioProfile", "dynamic"), null);
  assert.equal(model.parameterDefaultsForChange("audioProfile", "subtle"), null);
  assert.equal(model.parameterDefaultsForChange("audioProfile", "off"), null);
  assert.deepEqual(model.parameterDefaultsForChange("beatShockwave", "pointer"), {
    disturbanceMode: "shockwave",
  });

  // Backward compatibility: legacy saved ambient and rhythm runs reopen as custom
  assert.equal(model.normalizeStoredParameter("audioProfile", "ambient"), "custom");
  assert.equal(model.normalizeStoredParameter("audioProfile", "rhythm"), "custom");
  assert.equal(model.normalizeStoredParameter("audioProfile", "subtle"), "subtle");
  assert.equal(model.normalizeStoredParameter("audioProfile", "continuous"), "continuous");
  assert.equal(model.normalizeStoredParameter("channelView", "invalid"), "phenotype");
  assert.equal(model.normalizeStoredParameter("channelView", "fast_signals"), "fast_signals");

  assert.equal(detectAudioProfile({}), "off");

  // Subtle route detection
  const subtleRoutes = {
    rotation: { source: "kick", depth: 0.25 },
    twist: { source: "kick", depth: 0.01 },
    reliefStrength: { source: "kick", depth: 0.25 },
    lightAngle: { source: "kick", depth: -0.10 },
  };
  assert.equal(detectAudioProfile(subtleRoutes), "subtle");

  // Continuous route detection
  const continuousRoutes = {
    rotation: { source: "kick", depth: 0.05 },
    twist: { source: "kick", depth: 0.05 },
    reliefStrength: { source: "kick", depth: -1.00 },
    lightAngle: { source: "kick", depth: 1.00 },
  };
  assert.equal(detectAudioProfile(continuousRoutes), "continuous");

  // Dynamic route detection
  const dynamicRoutes = {
    rotation: { source: "kick", depth: 0.10 },
    twist: { source: "kick", depth: 0.06 },
    reliefStrength: { source: "kick", depth: -0.80 },
    lightAngle: { source: "kick", depth: 0.90 },
  };
  assert.equal(detectAudioProfile(dynamicRoutes), "dynamic");

  // Custom route detection
  assert.equal(
    detectAudioProfile({
      reliefStrength: { source: "kick", depth: 0.8 },
    }),
    "custom",
  );

  // Composite preset recognition with base values and LFOs
  const subtleBase = {
    growthSpeed: 60,
    rotation: 185,
    twist: 0,
    reliefStrength: 1.8,
    lightAngle: 210,
    shading: "relief",
    coordinateTransform: "cartesian",
    beatShockwave: "center",
    shockwaveReach: "canvas",
    kickInfusion: "subtle",
  };
  const subtleLfos = {
    rotation: { enabled: false, rate: 0.05, depth: 0.80, phase: 0 },
    twist: { enabled: true, rate: 0.04, depth: 0.72, phase: 0, waveform: "sine" },
    reliefStrength: { enabled: false, rate: 0.10, depth: 1.00, phase: 0 },
    lightAngle: { enabled: false, rate: 0.10, depth: 0.20, phase: 0 },
  };
  assert.equal(
    detectAudioProfile({
      matrix: subtleRoutes,
      parameters: subtleBase,
      lfoState: subtleLfos,
    }),
    "subtle",
  );

  // Editing base values switches selection to custom
  assert.equal(
    detectAudioProfile({
      matrix: subtleRoutes,
      parameters: { ...subtleBase, rotation: 200 },
      lfoState: subtleLfos,
    }),
    "custom",
  );

  // Editing LFO settings switches selection to custom
  assert.equal(
    detectAudioProfile({
      matrix: subtleRoutes,
      parameters: subtleBase,
      lfoState: {
        ...subtleLfos,
        twist: { enabled: false },
      },
    }),
    "custom",
  );

  // Continuous with Cartesian geometry fails recognition (must be vortex or other non-cartesian)
  const continuousBase = {
    growthSpeed: 100,
    rotation: 180,
    twist: 0,
    reliefStrength: 1.5,
    lightAngle: 180,
    shading: "relief",
    coordinateTransform: "cartesian",
    kickInfusion: "subtle",
  };
  const continuousLfos = {
    rotation: { enabled: true, rate: 0.05, depth: 1.00, phase: 0.50, waveform: "sine" },
    twist: { enabled: true, rate: 0.01, depth: 0.50, phase: 0, waveform: "sine" },
    reliefStrength: { enabled: true, rate: 0.005, depth: 1.00, phase: 1.00, waveform: "sine" },
    lightAngle: { enabled: true, rate: 0.01, depth: 1.00, phase: 0, waveform: "sine" },
  };
  assert.equal(
    detectAudioProfile({
      matrix: continuousRoutes,
      parameters: continuousBase,
      lfoState: continuousLfos,
    }),
    "custom",
  );
  assert.equal(
    detectAudioProfile({
      matrix: continuousRoutes,
      parameters: { ...continuousBase, coordinateTransform: "vortex" },
      lfoState: continuousLfos,
    }),
    "continuous",
  );

  // Dynamic composite preset recognition
  const dynamicBase = {
    growthSpeed: 45,
    rotation: 180,
    twist: 0,
    reliefStrength: 1.4,
    lightAngle: 180,
    shading: "relief",
    coordinateTransform: "vortex",
    kickInfusion: "dynamic",
  };
  const dynamicLfos = {
    rotation: { enabled: true, rate: 0.05, depth: 1.00, calmDepth: 0.12, phase: 0.50, waveform: "sine" },
    twist: { enabled: true, rate: 0.015, depth: 0.60, calmDepth: 0.08, phase: 0, waveform: "sine" },
    reliefStrength: { enabled: true, rate: 0.008, depth: 0.90, calmDepth: 0.15, phase: 1.00, waveform: "sine" },
    lightAngle: { enabled: true, rate: 0.012, depth: 0.90, calmDepth: 0.10, phase: 0, waveform: "sine" },
  };
  assert.equal(
    detectAudioProfile({
      matrix: dynamicRoutes,
      parameters: dynamicBase,
      lfoState: dynamicLfos,
    }),
    "dynamic",
  );
  assert.equal(
    detectAudioProfile({
      matrix: dynamicRoutes,
      parameters: { ...dynamicBase, growthSpeed: 60 },
      lfoState: dynamicLfos,
    }),
    "custom",
  );

  assert.equal(model.triggerBeatShockwave("off"), false);
  assert.equal(model.triggerBeatShockwave("center"), true);
  assert.equal(model._queuedDisturbances.length, 1);
  const centerPulse = model._queuedDisturbances[0];
  assert.equal(centerPulse.x, 64);
  assert.equal(centerPulse.y, 64);
  assert.equal(centerPulse.mode, "shockwave");

  assert.equal(
    model.triggerBeatShockwave("pointer", { x: 30, y: 40 }),
    true,
  );
  assert.equal(model._queuedDisturbances.length, 2);
  const pointerPulse = model._queuedDisturbances[1];
  assert.equal(pointerPulse.x, 30);
  assert.equal(pointerPulse.y, 40);
  assert.equal(pointerPulse.mode, "shockwave");

  model.step();
  assert.equal(runtimes[0].disturbances.length, 2);
  assert.equal(runtimes[0].disturbances[0][3], "shockwave");
  assert.equal(runtimes[0].disturbances[0][4].shockwaveImpact, "color");
  assert.equal(runtimes[0].disturbances[1][3], "shockwave");
  assert.equal(runtimes[0].disturbances[1][4].shockwaveImpact, "color");

  model.onParameterChange("shockwaveImpact", "none");
  assert.equal(model.triggerBeatShockwave("center"), true);
  model.step();
  assert.equal(runtimes[0].disturbances.length, 3);
  assert.equal(runtimes[0].disturbances[2][3], "shockwave");
  assert.equal(runtimes[0].disturbances[2][4].shockwaveImpact, "none");

  await model.render(canvas, model.parameters, 0.1, { advanceSimulation: true });
  assert.equal(runtimes[0].lastDrawOptions.shockwaveStyle, "refract");
  assert.equal(runtimes[0].lastDrawOptions.channelView, "phenotype");
  assert.equal(runtimes[0].lastDrawOptions.displayFilter, "smooth");

  model.onParameterChange("channelView", "fast_signals");
  await model.render(canvas, model.parameters, 0.2, { advanceSimulation: true });
  assert.equal(runtimes[0].lastDrawOptions.channelView, "fast_signals");

  // Kick input: active when impact is color
  model.onParameterChange("shockwaveImpact", "color");
  assert.equal(model.triggerKickInput(0.8, 1000), true);
  // Refractory lockout (< 180ms)
  assert.equal(model.triggerKickInput(0.8, 1050), false);
  // Allowed after cooldown
  assert.equal(model.triggerKickInput(0.8, 1250), true);

  model.onParameterChange("shockwaveImpact", "none");
  assert.equal(model.triggerKickInput(0.8, 1500), false);

  model.queueDisturbance(20, 20, 10, "invert");
  model.step();
  const distModes = runtimes[0].disturbances.map((d) => d[3]);
  assert.ok(distModes.includes("kick_color"));
  assert.equal(distModes[distModes.length - 1], "invert");
});

test("simulationSize options and normalization adapt dynamically to hardware capabilities", () => {
  // Constrained device (e.g. mobile or headless software WebGL with maxTextureSize 8192 or 2048)
  const constrainedModel = new NeuralGrowthModel({
    capabilities: { maxTextureSize: 8192 },
  });
  const constrainedSizes = constrainedModel.controls.find(
    (c) => c.key === "simulationSize",
  ).options.map((o) => o.value);
  assert.deepEqual(constrainedSizes, [128, 256]);
  assert.equal(constrainedModel.normalizeStoredParameter("simulationSize", 512), 256);
  assert.equal(constrainedModel.normalizeStoredParameter("simulationSize", 256), 256);
  assert.equal(constrainedModel.normalizeStoredParameter("simulationSize", 128), 128);

  // High-DPI capable device (e.g. desktop GPU with maxTextureSize 16384 >= 12288)
  const capableModel = new NeuralGrowthModel({
    capabilities: { maxTextureSize: 16384 },
  });
  const capableControl = capableModel.controls.find(
    (c) => c.key === "simulationSize",
  );
  const capableSizes = capableControl.options.map((o) => o.value);
  assert.deepEqual(capableSizes, [128, 256, 512]);
  assert.equal(capableModel.normalizeStoredParameter("simulationSize", 512), 512);

  const ultraOption = capableControl.options.find((o) => o.value === 512);
  assert.equal(ultraOption.compute, "demanding");
  assert.ok(ultraOption.guidance.includes("262,144"));

  // Dynamic capabilities update
  constrainedModel.capabilities = { maxTextureSize: 16384 };
  const updatedSizes = constrainedModel.controls.find(
    (c) => c.key === "simulationSize",
  ).options.map((o) => o.value);
  assert.deepEqual(updatedSizes, [128, 256, 512]);
});

test("audio frame re-arms during silence and triggers kick shockwave and kick input", () => {
  let lastBeatTime = 0;
  let beatArmed = true;
  const shockwaves = [];
  const kickInputs = [];

  const mockModel = {
    ready: true,
    isClockRunning: true,
    parameters: { audioProfile: "dynamic", beatShockwave: "off" },
    triggerBeatShockwave: (m) => shockwaves.push(m),
    triggerKickInput: (k, t) => {
      kickInputs.push({ k, t });
      return true;
    },
  };

  function simulateAudioFrame(levels, timestamp) {
    if (!mockModel?.ready || !levels) return;
    const triggerKick = Number(levels.kickOnset ?? levels.kick) || 0;
    if (!levels.hasSignal || triggerKick < 0.25) {
      beatArmed = true;
    }
    if (!levels.hasSignal) return;

    const elapsed = timestamp - lastBeatTime;
    if (beatArmed && triggerKick >= 0.55 && elapsed >= 180) {
      lastBeatTime = timestamp;
      beatArmed = false;
      const mode = mockModel.parameters?.beatShockwave || "off";
      const isAudioActive = (mockModel.parameters?.audioProfile || "off") !== "off";
      if (mode === "center" || (mode !== "pointer" && isAudioActive)) {
        mockModel.triggerBeatShockwave("center");
        if (typeof mockModel.triggerKickInput === "function") {
          mockModel.triggerKickInput(triggerKick, timestamp);
        }
      }
    }
  }

  // 1. Kick 1 spikes
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.8 }, 1000);
  assert.equal(shockwaves.length, 1);
  assert.equal(kickInputs.length, 1);

  // 2. Immediate frame still hot (< 180ms or unarmed)
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.8 }, 1050);
  assert.equal(shockwaves.length, 1);

  // 3. Silence gap (hasSignal: false): must re-arm!
  simulateAudioFrame({ hasSignal: false, kickOnset: 0.0 }, 1200);
  assert.equal(beatArmed, true);

  // 4. Kick 2 after silence: must trigger!
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.75 }, 1300);
  assert.equal(shockwaves.length, 2);
  assert.equal(kickInputs.length, 2);

  // 5. Steady bass without onset (kickOnset: 0.2, kick: 0.3): must not trigger shockwave
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.2, kick: 0.3 }, 1500);
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.3, kick: 0.4 }, 1700);
  assert.equal(shockwaves.length, 2);

  // 6. Audio Off profile: must not trigger shockwave
  mockModel.parameters.audioProfile = "off";
  simulateAudioFrame({ hasSignal: false }, 1800);
  simulateAudioFrame({ hasSignal: true, kickOnset: 0.9 }, 1900);
  assert.equal(shockwaves.length, 2);
});

test("neural growth controls provide contextual guidance and dormant tap recovery", () => {
  const model = new NeuralGrowthModel();
  const controls = model.controls;

  // 1. Growth speed guidance
  const speedCtrl = controls.find((c) => c.key === "growthSpeed");
  assert.ok(speedCtrl && typeof speedCtrl.getGuidance === "function");
  assert.equal(speedCtrl.getGuidance(0).tag, "paused");
  assert.equal(speedCtrl.getGuidance(30).tag, "recommended");
  assert.equal(speedCtrl.getGuidance(60).tag, "active");
  assert.equal(speedCtrl.getGuidance(100).tag, "rapid");

  // 2. Coordinate transform options and tags
  const transformCtrl = controls.find((c) => c.key === "coordinateTransform");
  assert.ok(transformCtrl && Array.isArray(transformCtrl.options));
  const cartesianOpt = transformCtrl.options.find((o) => o.value === "cartesian");
  const spiralOpt = transformCtrl.options.find((o) => o.value === "spiral");
  assert.equal(cartesianOpt.tag, "recommended");
  assert.equal(spiralOpt.tag, "swirl");
  assert.ok(spiralOpt.guidance.includes("Logarithmic swirl"));

  // 3. Twist contextual guidance
  const twistCtrl = controls.find((c) => c.key === "twist");
  assert.ok(twistCtrl && typeof twistCtrl.getGuidance === "function");
  // In Cartesian mode: inactive
  assert.equal(twistCtrl.getGuidance(25, { coordinateTransform: "cartesian" }).tag, "inactive");
  // In Spiral mode: contextual ranges
  assert.equal(twistCtrl.getGuidance(5, { coordinateTransform: "spiral" }).tag, "gentle");
  assert.equal(twistCtrl.getGuidance(30, { coordinateTransform: "spiral" }).tag, "recommended");
  assert.equal(twistCtrl.getGuidance(55, { coordinateTransform: "spiral" }).tag, "vivid");
  assert.equal(twistCtrl.getGuidance(85, { coordinateTransform: "spiral" }).tag, "high shear");

  // 4. Disturbance mode guidance
  const modeCtrl = controls.find((c) => c.key === "disturbanceMode");
  assert.ok(modeCtrl && Array.isArray(modeCtrl.options));
  const eraseOpt = modeCtrl.options.find((o) => o.value === "erase");
  const noiseOpt = modeCtrl.options.find((o) => o.value === "noise");
  assert.equal(eraseOpt.tag, "clear");
  assert.equal(noiseOpt.tag, "re-seed");

  // 5. Channel inspector guidance
  const channelCtrl = controls.find((c) => c.key === "channelView");
  assert.ok(channelCtrl && Array.isArray(channelCtrl.options));
  const phenotypeOpt = channelCtrl.options.find((o) => o.value === "phenotype");
  const signalsOpt = channelCtrl.options.find((o) => o.value === "fast_signals");
  assert.equal(phenotypeOpt.tag, "recommended");
  assert.equal(signalsOpt.tag, "ch 4-6");

  // 6. Dormant check on model without runtime returns false
  assert.equal(model.isDormant(), false);
});

test("persistent kick detail infusion injects hidden channels with bounded rate and paused safety", () => {
  const model = new NeuralGrowthModel();

  // 1. Control declaration and options
  const infusionCtrl = model.controls.find((c) => c.key === "kickInfusion");
  assert.ok(infusionCtrl);
  assert.equal(infusionCtrl.type, "select");
  assert.equal(infusionCtrl.default, "off");
  assert.deepEqual(
    infusionCtrl.options.map((o) => o.value),
    ["off", "subtle", "dynamic"],
  );

  // 2. Parameter normalization
  assert.equal(model.normalizeStoredParameter("kickInfusion", "dynamic"), "dynamic");
  assert.equal(model.normalizeStoredParameter("kickInfusion", "subtle"), "subtle");
  assert.equal(model.normalizeStoredParameter("kickInfusion", "invalid"), "off");

  // 3. Model not ready returns false
  assert.equal(model.triggerKickInfusion(1.0, 1000), false);

  // 4. Setup mock runtime and ready state
  const disturbances = [];
  model._runtime = {
    disturb: (x, y, r, mode, opts) => {
      disturbances.push({ x, y, r, mode, ...opts });
    },
  };
  model._currentPatternId = "test";
  model._needsRuntime = false;
  model._loadingPattern = false;
  model.lastError = null;
  assert.equal(model.ready, true);
  model._clockRunning = true;
  model._parameters.growthSpeed = 30;

  // 5. When kickInfusion is off, returns false
  model._parameters.kickInfusion = "off";
  assert.equal(model.triggerKickInfusion(0.8, 1000), false);
  assert.equal(disturbances.length, 0);

  // 6. When paused (clock not running or growthSpeed 0), returns false with zero backlog
  model._parameters.kickInfusion = "subtle";
  model._clockRunning = false;
  assert.equal(model.triggerKickInfusion(0.8, 1000), false);
  model._clockRunning = true;
  model._parameters.growthSpeed = 0;
  assert.equal(model.triggerKickInfusion(0.8, 1000), false);
  assert.equal(disturbances.length, 0);

  // 7. Successful subtle injection targeting hidden channels only
  model._parameters.growthSpeed = 30;
  const initialSeed = model.parameters.seed;
  assert.equal(model.triggerKickInfusion(0.7, 1000), true);
  assert.equal(disturbances.length, 1);
  assert.equal(disturbances[0].mode, "kick_hidden_perturb");
  assert.equal(disturbances[0].r, 12);
  assert.ok(disturbances[0].strength >= 0.7 && disturbances[0].strength <= 0.8);
  assert.equal(disturbances[0].lockBarrier, true);
  // Seed must remain unchanged
  assert.equal(model.parameters.seed, initialSeed);

  // 8. Refractory lockout (< 180 ms) rejects subsequent kick
  assert.equal(model.triggerKickInfusion(0.9, 1100), false);
  assert.equal(disturbances.length, 1);

  // 9. Leaky bucket bounds (rapid triggers after 180ms lockout)
  assert.equal(model.triggerKickInfusion(0.7, 1200), true);
  assert.equal(disturbances.length, 2);
  assert.equal(model.triggerKickInfusion(0.7, 1400), true);
  assert.equal(disturbances.length, 3);
  assert.equal(model.triggerKickInfusion(0.7, 1600), true);
  assert.equal(disturbances.length, 4);
  assert.equal(model.triggerKickInfusion(0.7, 1800), true);
  assert.equal(disturbances.length, 5);
  // Budget exhausted at 2000 (budget >= 3.0)
  assert.equal(model.triggerKickInfusion(0.7, 2000), false);
  assert.equal(disturbances.length, 5);

  // 10. Dynamic mode with intense kick (> 0.85) dispatches satellite patch
  model._parameters.kickInfusion = "dynamic";
  // Advance time to clear leaky bucket budget
  assert.equal(model.triggerKickInfusion(0.95, 5000), true);
  // Dynamic with norm > 0.85 injects 2 patches: primary + satellite
  assert.equal(disturbances.length, 7);
  const primary = disturbances[5];
  const satellite = disturbances[6];
  assert.equal(primary.mode, "kick_hidden_perturb");
  assert.equal(satellite.mode, "kick_hidden_perturb");
  assert.equal(primary.r, 16);
  assert.ok(satellite.r < primary.r);

  // 11. Cancel resets rate limiter state and stops clock
  model.cancel();
  assert.equal(model._lastKickInfusionTime, 0);
  assert.equal(model._kickInfusionBudget, 0);
  assert.equal(model._kickInfusionIndex, 0);
  assert.equal(model._clockRunning, false);
});



