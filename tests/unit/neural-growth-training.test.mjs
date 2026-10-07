import test from "node:test";
import assert from "node:assert/strict";
import * as tf from "@tensorflow/tfjs";
import { createTrainer } from "../../prototypes/neural-growth/training/trainer.js";
import { validateCheckpoint } from "../../assets/js/models/neural-growth/reference.js";

test("from-scratch trainer has connected gradients, valid exports and bounded tensor lifetimes", async () => {
  await tf.setBackend("cpu");
  const baseline = tf.memory().numTensors;
  const image = {
    width: 16,
    height: 16,
    data: Uint8Array.from({ length: 16 * 16 * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : 40 + ((index * 17) % 180),
    ),
  };
  const trainer = createTrainer(tf, image, { size: 8, spatial: true });
  try {
    // The output matrix intentionally starts at zero. Use a seeded nonzero
    // fixture to test the first layer without its quantized warm-up delay.
    const outputFixture = tf.randomNormal(
      trainer.variables[1].shape,
      0,
      0.03,
      "float32",
      91,
    );
    trainer.variables[1].assign(outputFixture);
    outputFixture.dispose();
    const before = await Promise.all(
      trainer.variables.map((variable) =>
        variable.data().then((data) => Array.from(data)),
      ),
    );
    const first = await trainer.trainIteration();
    const second = await trainer.trainIteration();
    assert.ok(Number.isFinite(first.loss) && Number.isFinite(second.loss));
    assert.equal(first.tensors, second.tensors);
    const after = await Promise.all(
      trainer.variables.map((variable) => variable.data()),
    );
    assert.ok(
      after.every((weights, layer) =>
        weights.some((value, index) => value !== before[layer][index]),
      ),
      "Both learned layers must receive connected gradients.",
    );
    const exported = await trainer.checkpoint();
    assert.equal(validateCheckpoint(exported.checkpoint).id, "membrane-field");
    assert.equal(exported.training.iteration, 2);
    assert.equal(
      exported.training.objective,
      "multiscale-fixed-feature-spatial-v2",
    );
    const snapshot = trainer.checkpoint();
    const replacement = tf.zeros(trainer.variables[0].shape);
    trainer.variables[0].assign(replacement);
    replacement.dispose();
    assert.deepEqual(
      (await snapshot).checkpoint.layers,
      exported.checkpoint.layers,
      "Export must snapshot weights before asynchronous reads.",
    );
  } finally {
    trainer.dispose();
  }
  trainer.dispose();
  assert.equal(tf.memory().numTensors, baseline);
});
