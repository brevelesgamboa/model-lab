import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainMotionField,
  limitMotionField,
  motionFieldStats,
} from "../../assets/js/models/neural-growth/motion-field.js";

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
