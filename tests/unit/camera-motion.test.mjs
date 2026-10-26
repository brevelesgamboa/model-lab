import test from "node:test";
import assert from "node:assert/strict";
import {
  CameraMotionEngine,
  CAMERA_BREATHING_MODES,
} from "../../assets/js/models/neural-growth/camera-motion.js";

test("CameraMotionEngine initializes with valid defaults", () => {
  const engine = new CameraMotionEngine();
  assert.equal(engine.kickPulse, 0);
  assert.equal(engine.smoothBass, 0);
  assert.equal(engine.panX, 0);
  assert.equal(engine.panY, 0);
  assert.ok(Array.isArray(CAMERA_BREATHING_MODES));
  assert.equal(CAMERA_BREATHING_MODES.length, 4);
});

test("CameraMotionEngine remains idle when mode is off or audio is silent", () => {
  const engine = new CameraMotionEngine();
  const levels = { hasSignal: false, kickOnset: 0.9, bass: 0.8 };

  const motion = engine.update(levels, 1000, { cameraBreathing: "off" });
  assert.equal(motion.zoomOffset, 0);
  assert.equal(motion.isMoving, false);
});

test("CameraMotionEngine triggers kick pulse and decays exponentially", () => {
  const engine = new CameraMotionEngine();
  const levels = { hasSignal: true, kickOnset: 0.9, bass: 0.2 };

  // Initial beat onset
  const m1 = engine.update(levels, 1000, {
    cameraBreathing: "punchy",
    cameraReactivity: 0.8,
  });
  assert.ok(m1.zoomOffset > 0.05);
  assert.equal(m1.isMoving, true);

  // Subsequent frame 50ms later with no new onset: should decay
  const quietLevels = { hasSignal: true, kickOnset: 0.0, bass: 0.1 };
  const m2 = engine.update(quietLevels, 1050, {
    cameraBreathing: "punchy",
    cameraReactivity: 0.8,
  });
  assert.ok(m2.zoomOffset < m1.zoomOffset);
  assert.ok(m2.zoomOffset > 0);

  // After 500ms of quiet audio: should decay near baseline
  const m3 = engine.update(quietLevels, 1500, {
    cameraBreathing: "punchy",
    cameraReactivity: 0.8,
  });
  assert.ok(m3.zoomOffset < 0.01);
});

test("CameraMotionEngine enforces pulse ceiling under rapid kicks", () => {
  const engine = new CameraMotionEngine();
  const levels = { hasSignal: true, kickOnset: 1.0, bass: 0.5 };

  // Fire 10 rapid kicks in close succession
  let maxObserved = 0;
  for (let i = 0; i < 10; i += 1) {
    const m = engine.update(levels, 1000 + i * 15, {
      cameraBreathing: "punchy",
      cameraReactivity: 1.0,
    });
    if (m.zoomOffset > maxObserved) maxObserved = m.zoomOffset;
  }

  // Ceiling for punchy is clamped (maxPulse <= 0.20 + breath)
  assert.ok(maxObserved <= 0.26);
});

test("CameraMotionEngine produces harmonic drift in drift mode", () => {
  const engine = new CameraMotionEngine();
  const levels = { hasSignal: true, kickOnset: 0.4, bass: 0.8, activity: 0.7 };

  // Step through 200ms
  engine.update(levels, 1000, { cameraBreathing: "drift", cameraReactivity: 0.7 });
  const m2 = engine.update(levels, 1200, { cameraBreathing: "drift", cameraReactivity: 0.7 });

  assert.ok(Math.abs(m2.panX) > 0 || Math.abs(m2.panY) > 0);
  // Pan is bounded within 5% of field
  assert.ok(Math.abs(m2.panX) <= 0.05);
  assert.ok(Math.abs(m2.panY) <= 0.05);
});

