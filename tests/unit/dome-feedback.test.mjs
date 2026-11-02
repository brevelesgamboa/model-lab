import test from "node:test";
import assert from "node:assert/strict";
import { prepareDomeFeedback } from "../../assets/js/render/dome-feedback.js";

test("feedback freezes when paused and resets after discontinuous movement, source changes and resize", () => {
  let copies = 0;
  const gl = {
    activeTexture() {},
    bindTexture() {},
    texImage2D() {},
    copyTexSubImage2D() {
      copies++;
    },
  };
  const graphics = { textures: Array(13).fill({}) };
  const frame = {
    width: 320,
    height: 240,
    active: true,
    epoch: "source-a",
    position: [0, -3],
    yaw: 0,
    pitch: 0,
    time: 0,
    signature: "a",
  };
  assert.equal(prepareDomeFeedback(gl, graphics, frame).valid, false);
  const next = { ...frame, position: [0, -3.1], signature: "b" };
  assert.equal(prepareDomeFeedback(gl, graphics, next).valid, true);
  assert.equal(copies, 1);
  prepareDomeFeedback(gl, graphics, next);
  assert.equal(copies, 1, "paused rendering must not recursively copy itself");
  for (const reset of [
    { position: [0, -40] },
    { epoch: "source-b" },
    { width: 640 },
    { active: false },
    { yaw: 1.5 },
    { time: 2 },
  ]) {
    prepareDomeFeedback(gl, graphics, {
      ...next,
      ...reset,
      signature: JSON.stringify(reset),
    });
    assert.equal(graphics.feedback.valid, false);
    prepareDomeFeedback(gl, graphics, { ...next, signature: "restore" });
  }
});
