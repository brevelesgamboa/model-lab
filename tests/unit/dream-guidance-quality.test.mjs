import test from "node:test";
import assert from "node:assert/strict";
import {
  DreamGuidanceBridge,
  applySpatialGradientSmoothing,
  unrollGradient,
  INCEPTION_LAYERS,
} from "../../assets/js/models/neural-growth/dream-guidance.js";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";
import { readFile } from "node:fs/promises";

async function cpu(context) {
  const tf = await import("@tensorflow/tfjs");
  await tf.setBackend("cpu");
  await tf.ready();
  const previous = globalThis.tf;
  globalThis.tf = tf;
  context.after(() => {
    globalThis.tf = previous;
  });
  return tf;
}

function phenotype(size) {
  return Uint8Array.from({ length: size * size * 4 }, (_, i) =>
    i % 4 === 3
      ? 255
      : 127 +
        Math.round(
          45 *
            Math.sin((Math.floor(i / 4) % size) * 0.4) *
            Math.cos(Math.floor(i / (4 * size)) * 0.3),
        ),
  );
}

test("jittered gradients remain pinned to the same cells across temporal updates", async (context) => {
  const tf = await cpu(context);
  const baseline = tf.memory().numTensors;
  const graph = { execute: (input) => input.square() };
  const random = [0, 0.999, 0.9, 0.2];
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: graph }),
    random: () => random.shift(),
  });
  context.after(() => bridge.dispose());
  const bytes = phenotype(16);
  const expected = await bridge.computeGradient(
    bytes,
    16,
    16,
    "mixed_5b",
    -1,
    false,
    0,
  );
  const reference = new Float32Array(bridge._prevGrad);
  bridge.resetMomentum();
  await bridge.computeGradient(bytes, 16, 16, "mixed_5b", -1, true, 0);
  const result = await bridge.computeGradient(
    bytes,
    16,
    16,
    "mixed_5b",
    -1,
    true,
    0,
  );
  assert.ok(
    reference.every((value, i) => Math.abs(value - bridge._prevGrad[i]) < 1e-5),
  );
  assert.ok(result.every((value, i) => Math.abs(value - expected[i]) <= 1));
  assert.equal(tf.memory().numTensors, baseline);
});

test("float unrolling preserves RGB vectors and toroidal cell coordinates", () => {
  const rolled = new Float32Array(8 * 8 * 3);
  rolled.set([0.7, -0.2, 0.4], (6 * 8 + 1) * 3);
  const aligned = unrollGradient(rolled, 8, 8, 3, -2);
  const index = (0 * 8 + 6) * 3;
  assert.deepEqual(
    Array.from(aligned.slice(index, index + 3)),
    Array.from(rolled.slice((6 * 8 + 1) * 3, (6 * 8 + 1) * 3 + 3)),
  );
  assert.equal(aligned.filter((value) => value !== 0).length, 3);
});

test("sigma 1–1.5 suppresses pixel noise while preserving directional low-frequency structure", () => {
  const size = 64;
  const input = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      input[(y * size + x) * 3] =
        Math.sin((2 * Math.PI * x) / 32) + 0.4 * (-1) ** (x + y);
  for (const sigma of [1, 1.25, 1.5]) {
    const output = applySpatialGradientSmoothing(input, size, size, sigma);
    let direction = 0;
    let pixels = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const value = output[(y * size + x) * 3];
        direction += value * Math.sin((2 * Math.PI * x) / 32);
        pixels += value * (-1) ** (x + y);
      }
    assert.ok(
      (direction * 2) / (size * size) > 0.96,
      `Directional attenuation at sigma ${sigma}`,
    );
    assert.ok(
      Math.abs(pixels / (size * size)) < 0.004,
      `Pixel suppression at sigma ${sigma}`,
    );
    const constant = new Float32Array(5 * 5 * 3).fill(0.25);
    assert.ok(
      applySpatialGradientSmoothing(constant, 5, 5, sigma).every(
        (value) => Math.abs(value - 0.25) < 1e-7,
      ),
    );
  }
});

test("a target changed A→B→A rejects delayed GPU data and cannot repopulate history", async (context) => {
  const tf = await cpu(context);
  const baseline = tf.memory().numTensors;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({
      model: { execute: (input) => input.square() },
    }),
  });
  context.after(() => bridge.dispose());
  bridge.getTensorFlow = async () => ({
    ...tf,
    tidy: (callback) => {
      const tensor = tf.tidy(callback);
      const data = tensor.data.bind(tensor);
      tensor.data = async () => {
        entered();
        await gate;
        return data();
      };
      return tensor;
    },
  });
  const first = bridge.computeGradient(
    phenotype(8),
    8,
    8,
    "mixed_5b",
    0,
    false,
    0,
  );
  await started;
  assert.equal(
    await bridge.computeGradient(phenotype(8), 8, 8, "mixed_5c", 1, false, 0),
    null,
  );
  assert.equal(
    await bridge.computeGradient(phenotype(8), 8, 8, "mixed_5b", 0, false, 0),
    null,
  );
  assert.equal(bridge._prevGrad, null);
  release();
  assert.equal(await first, null);
  assert.equal(bridge._prevGrad, null);
  assert.equal(bridge.isBusy, false);
  assert.equal(tf.memory().numTensors, baseline);
});

test("in-flight guidance never reaches a new target, restart, pattern, or runtime", async () => {
  for (const invalidate of [
    (model) => model.onParameterChange("targetChannel", 2),
    (model) => model.onParameterChange("targetLayer", "Conv2d_4a_3x3"),
    (model) => model.onParameterChange("pattern", "xeno-reef"),
    (model) => model.onParameterChange("seed", 42),
    (model) => model.restart(),
    (model) => model.cancel(),
    (model) => {
      model._runtime = {
        disposed: false,
        updateDreamGradient() {
          throw new Error("Stale result reached replacement runtime");
        },
      };
    },
  ]) {
    const model = new NeuralGrowthModel();
    let resolve;
    let updates = 0;
    let resets = 0;
    const runtime = {
      disposed: false,
      readPhenotypeRgb: () => phenotype(192),
      updateDreamGradient: () => {
        updates += 1;
      },
      restart() {},
      clearDreamGradient() {},
    };
    model._runtime = runtime;
    model._dreamBridge = {
      isBusy: false,
      resetMomentum: () => {
        resets += 1;
      },
      computeGradient: () =>
        new Promise((done) => {
          resolve = done;
        }),
    };
    const pending = model._dispatchDreamGuidance("mixed_5b", 0, true, 0);
    invalidate(model);
    resolve(new Uint8Array(192 * 192 * 4).fill(127));
    await pending;
    assert.equal(updates, 0);
    if (model._runtime === runtime) assert.ok(resets > 0);
  }
});

test("all requested stem endpoints exist in the exact bundled graph", async () => {
  const graph = JSON.parse(
    await readFile(
      new URL("../../models/inception/model.json", import.meta.url),
      "utf8",
    ),
  );
  const nodes = new Set(graph.modelTopology.node.map((node) => node.name));
  const weights = graph.weightsManifest.flatMap((group) => group.weights);
  for (const [stem, channels] of [
    ["Conv2d_2b_3x3", 64],
    ["Conv2d_3b_1x1", 80],
    ["Conv2d_4a_3x3", 192],
  ]) {
    assert.ok(nodes.has(INCEPTION_LAYERS[stem]));
    assert.equal(
      weights.find(
        (weight) => weight.name === `module/InceptionV3/${stem}/weights`,
      ).shape[3],
      channels,
    );
  }
});
