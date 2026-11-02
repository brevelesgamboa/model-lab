import test from "node:test";
import assert from "node:assert/strict";
import { flowState } from "../../tools/dream-drift-flow-renderer.mjs";

test("cached model interpolation stays bounded and joins its slow cycle smoothly", () => {
  assert.equal(flowState(0).modelBlend, 1);
  assert.equal(flowState(20).modelBlend, 0);
  assert.equal(flowState(40).modelBlend, 1);
  for (let frame = 0; frame <= 2400; frame++) {
    const time = frame / 60,
      a = flowState(time).modelBlend,
      b = flowState(time + 1 / 60).modelBlend;
    assert(a >= 0 && a <= 1);
    assert(Math.abs(a - b) < 0.00131);
  }
  for (const join of [0, 20, 40])
    assert(
      Math.abs(
        flowState(join + 0.001).modelBlend - flowState(join).modelBlend,
      ) < 1e-8,
    );
});

test("frozen benchmarking uses the same model state and invalid times are rejected", () => {
  assert.deepEqual(flowState(100, false), flowState(0));
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(() => flowState(value), RangeError);
});
