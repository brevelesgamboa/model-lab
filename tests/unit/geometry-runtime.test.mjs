import test from "node:test";
import assert from "node:assert/strict";
import {
  TextureNcaRuntime,
  SPIRAL_MAX_PITCH_RADIANS,
  clampGeometryTwist,
  clampGeometryStrength,
} from "../../assets/js/models/neural-growth/runtime.js";
import { ResonanceConfig } from "../../assets/js/models/neural-growth/resonance-config.js";
import { applyLfo } from "../../assets/js/core/lfo.js";
import { applyAudioModulation } from "../../assets/js/core/modulation-matrix.js";

test("geometry guards cap spiral pitch at 89 degrees and reject non-finite inputs", () => {
  const limit = (89 * Math.PI) / 180;
  assert.equal(SPIRAL_MAX_PITCH_RADIANS, limit);
  for (const value of [Math.PI / 2, Math.PI, 100]) {
    assert.equal(clampGeometryTwist("spiral", value), limit);
    assert.equal(clampGeometryTwist("spiral", -value), -limit);
  }
  assert.equal(clampGeometryTwist("spiral", "0.5"), 0.5);
  assert.equal(clampGeometryTwist("wave", Math.PI), Math.PI);
  assert.equal(clampGeometryStrength(-0.1), 0);
  assert.equal(clampGeometryStrength(1.1), 1);
  assert.equal(clampGeometryStrength("0.4"), 0.4);
  for (const value of [NaN, Infinity, -Infinity, undefined, "invalid"]) {
    assert.equal(clampGeometryTwist("spiral", value), 0);
    assert.equal(clampGeometryStrength(value), 1);
  }
});

test("runtime guards combined audio and LFO pitch while retaining resonance uploads", () => {
  const runtime = Object.create(TextureNcaRuntime.prototype);
  const uploads = new Map();
  Object.assign(runtime, {
    gl: { isContextLost: () => false },
    size: 128,
    steps: 10,
    layout: { random: () => 0.5 },
    model: { layers: [{ scale: 1 }, { scale: 1 }] },
    weights: [{}, {}],
    run: (name, _output, _inputs, uniforms) => uploads.set(name, uniforms),
  });
  const definition = { type: "range", min: -90, max: 90 };
  const lfo = { enabled: true, waveform: "sine", rate: 1, depth: 1, phase: 0 };
  const resonance = new ResonanceConfig({
    enabled: true,
    perceptionDrift: 0.02,
    latentFeedback: 0.35,
  });
  for (const [time, depth, expectedPitch, strength, expectedStrength] of [
    [0.25, 1, SPIRAL_MAX_PITCH_RADIANS, 2, 1],
    [0.75, -1, -SPIRAL_MAX_PITCH_RADIANS, -1, 0],
  ]) {
    const degrees = applyAudioModulation(
      definition,
      applyLfo(definition, 0, lfo, time),
      { source: "kick", depth },
      { kick: 1 },
    );
    const step = runtime.steps;
    runtime.step(1, {
      coordinateTransform: "spiral",
      twist: (degrees * Math.PI) / 180,
      geometryStrength: strength,
      rotation: 0.3,
      resonance,
    });
    assert.equal(uploads.get("perception").u_twist, expectedPitch);
    assert.equal(
      uploads.get("perception").u_geometryStrength,
      expectedStrength,
    );
    assert.equal(uploads.get("perception").u_angle, 0.3);
    assert.equal(uploads.get("perception").u_perceptionPhase, step * 0.02);
    assert.equal(uploads.get("update").u_resonanceFeedback, 0.35);
    assert.equal(runtime.steps, step + 1);
  }
});
