import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainMotionField,
  limitMotionField,
  motionFieldStats,
} from "../../assets/js/models/neural-growth/motion-field.js";
import {
  warpWithMotion,
  InceptionMotionController,
} from "../../assets/js/models/neural-growth/inception-motion.js";

test("periodic displacement gradients agree with finite differences", async () => {
  const tf = await import("@tensorflow/tfjs");
  await tf.setBackend("cpu");
  const before = tf.memory().numTensors;
  const image = tf.tensor4d(
    Float32Array.from(
      { length: 32 * 32 * 3 },
      (_, i) => Math.sin(i * 0.017) * 0.2 + 0.5,
    ),
    [1, 32, 32, 3],
  );
  const initial = new Float32Array(512).fill(0.013);
  const loss = (values) =>
    tf.tidy(() =>
      warpWithMotion(tf, image, values, { stateSize: 32, horizon: 4 })
        .square()
        .mean(),
    );
  const parameters = tf.tensor4d(initial, [1, 16, 16, 2]);
  const gradient = tf.grad(loss)(parameters);
  const data = await gradient.data();
  for (const i of [57, 182, 379]) {
    const perturbed = initial.slice(),
      epsilon = 0.0005;
    perturbed[i] += epsilon;
    const plus = tf.tidy(
      () => loss(tf.tensor4d(perturbed, [1, 16, 16, 2])).dataSync()[0],
    );
    perturbed[i] -= 2 * epsilon;
    const minus = tf.tidy(
      () => loss(tf.tensor4d(perturbed, [1, 16, 16, 2])).dataSync()[0],
    );
    assert.ok(Math.abs((plus - minus) / (2 * epsilon) - data[i]) < 6e-5);
  }
  assert.ok(data.some((value) => Math.abs(value) > 1e-5));
  gradient.dispose();
  parameters.dispose();
  image.dispose();
  assert.equal(tf.memory().numTensors, before);
});

test("velocity constraints bound magnitude, shear, temporal change and compression", () => {
  const input = Float32Array.from(
    { length: 512 },
    (_, i) => Math.sin(i * 0.31) * 2 + Math.cos(i * 0.17),
  );
  const previous = new Float32Array(512);
  const result = constrainMotionField(input, previous);
  const stats = motionFieldStats(result);
  assert.ok(stats.maxSpeed <= 0.00500001);
  assert.ok(stats.maxNeighborDelta <= 0.02);
  assert.ok(stats.divergenceRms < 1e-8);
  assert.ok(stats.rmsSpeed > 0);
  const projected = constrainMotionField(input);
  assert.ok(motionFieldStats(projected).maxSpeed <= 0.05);
  assert.ok(motionFieldStats(projected).maxNeighborDelta <= 0.02000001);
  assert.ok(limitMotionField(input).every(Number.isFinite));
  assert.equal(
    motionFieldStats(constrainMotionField(new Float32Array(512))).maxSpeed,
    0,
  );
  assert.throws(
    () => limitMotionField(new Float32Array(512).fill(NaN)),
    RangeError,
  );
});

test("target changes and disposal invalidate a pending motion request and clear its field", async () => {
  for (const invalidate of [
    (controller) => controller.setTarget("mixed_5b", 120),
    (controller) => controller.reset(),
    (controller) => controller.dispose(),
  ]) {
    let release;
    const controller = new InceptionMotionController({
      getInceptionModel: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    controller.field.fill(0.01);
    controller.history.fill(1);
    const pending = controller.update(new Uint8Array(32 * 32 * 4), 32, 32);
    invalidate(controller);
    release({
      execute() {
        throw new Error("Stale request executed");
      },
    });
    assert.equal(await pending, null);
    assert.ok(controller.field.every((value) => value === 0));
    assert.ok(controller.history.every((value) => value === 0));
    assert.equal(controller.busy, false);
  }
});

test("reset during gradient readback rejects the result and releases its tensors", async () => {
  const tf = await import("@tensorflow/tfjs");
  await tf.setBackend("cpu");
  const before = tf.memory().numTensors;
  let invalidate = false,
    resets = 0;
  const model = {
    execute(image) {
      if (invalidate) queueMicrotask(() => controller.reset());
      return image.square();
    },
  };
  const controller = new InceptionMotionController({
    getInceptionModel: () => model,
    getTensorFlow: () => tf,
    onReset: () => resets++,
  });
  const bytes = Uint8Array.from(
    { length: 32 * 32 * 4 },
    (_, i) => 127 + Math.round(50 * Math.sin(i * 0.013)),
  );
  const result = await controller.update(bytes, 32, 32);
  assert.equal(result.field.length, 512);
  assert.ok(Number.isFinite(result.scoreAfter));
  assert.equal(tf.memory().numTensors, before);
  invalidate = true;
  assert.equal(await controller.update(bytes, 32, 32), null);
  assert.equal(resets, 2);
  assert.ok(controller.field.every((value) => value === 0));
  assert.equal(controller.busy, false);
  assert.equal(tf.memory().numTensors, before);
  controller.dispose();
});
