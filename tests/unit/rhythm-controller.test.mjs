import test from "node:test";
import assert from "node:assert/strict";
import { RhythmController } from "../../assets/js/core/rhythm-controller.js";

function createMockAudio(sampleRate = 48000, fftSize = 2048) {
  const binCount = fftSize / 2;
  const binWidth = sampleRate / fftSize;
  const floatBuffer = new Float32Array(binCount).fill(-100);
  const byteBuffer = new Uint8Array(binCount).fill(0);

  const analyser = {
    fftSize,
    frequencyBinCount: binCount,
    minDecibels: -90,
    maxDecibels: -10,
    smoothingTimeConstant: 0.15,
    getFloatFrequencyData: (target) => target.set(floatBuffer),
    getByteFrequencyData: (target) => target.set(byteBuffer),
  };

  const context = {
    sampleRate,
    state: "running",
    resume: async () => {},
  };

  function setTone(frequencyHz, db = -12) {
    floatBuffer.fill(-100);
    byteBuffer.fill(0);
    const centerBin = Math.round(frequencyHz / binWidth);
    for (let offset = -2; offset <= 2; offset += 1) {
      const bin = centerBin + offset;
      if (bin >= 0 && bin < binCount) {
        const binDb = db - Math.abs(offset) * 3;
        floatBuffer[bin] = binDb;
        const norm = Math.max(
          0,
          Math.min(
            1,
            (binDb - analyser.minDecibels) /
              (analyser.maxDecibels - analyser.minDecibels),
          ),
        );
        byteBuffer[bin] = Math.round(norm * 255);
      }
    }
  }

  function setSilence() {
    floatBuffer.fill(-100);
    byteBuffer.fill(0);
  }

  return { analyser, context, setTone, setSilence, binWidth };
}

test("initial levels are zero and inactive", () => {
  const controller = new RhythmController();
  const levels = controller.getLevels();
  assert.equal(levels.bass, 0);
  assert.equal(levels.kick, 0);
  assert.equal(levels.kickOnset, 0);
  assert.equal(levels.hasSignal, false);
});

test("complete silence rejects signal and returns silent levels without auto-gain blowup", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = new Float32Array(mock.analyser.frequencyBinCount);
  controller.status = "active";

  mock.setSilence();
  const levels = controller.update(100);
  assert.equal(levels.hasSignal, false);
  assert.equal(levels.bass, 0);
  assert.equal(levels.kick, 0);
  assert.equal(levels.kickOnset, 0);
});

test("sustained ambient drone preserves bass level without decaying to zero", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = new Float32Array(mock.analyser.frequencyBinCount);
  controller.status = "active";

  // Simulate continuous 60 Hz ambient sub-bass drone at -20 dBFS
  mock.setTone(60, -20);

  let levels = null;
  // Step for 4 seconds at 60 fps
  for (let frame = 0; frame <= 240; frame += 1) {
    const timestamp = frame * 16.666;
    levels = controller.update(timestamp);
  }

  assert.ok(levels.hasSignal, "Ambient drone should register as active signal");
  assert.ok(
    levels.bass > 0.35,
    `Ambient bass level (${levels.bass}) should remain elevated, not adapted out`,
  );
  assert.ok(
    levels.kickOnset < 0.1,
    `Ambient drone should not trigger kick shockwaves (kickOnset = ${levels.kickOnset})`,
  );
});

test("repeated kicks at 120 BPM trigger onsets and re-arm reliably", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = new Float32Array(mock.analyser.frequencyBinCount);
  controller.status = "active";

  const beatIntervalMs = 500; // 120 BPM
  const kickDurationMs = 60;
  let shockwaveTriggers = 0;
  let beatArmed = true;
  let lastBeatTime = -1000;

  // Simulate 4 beats (2000 ms)
  const totalFrames = 120;
  const frameDurationMs = 16.666;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const timestamp = frame * frameDurationMs;
    const timeInBeat = timestamp % beatIntervalMs;

    if (timeInBeat < kickDurationMs) {
      mock.setTone(55, -8); // loud kick hit
    } else {
      mock.setSilence();
    }

    const levels = controller.update(timestamp);
    const triggerLevel = levels.kickOnset;

    if (triggerLevel < 0.25) {
      beatArmed = true;
    }

    const elapsed = timestamp - lastBeatTime;
    if (beatArmed && triggerLevel >= 0.55 && elapsed >= 180) {
      lastBeatTime = timestamp;
      beatArmed = false;
      shockwaveTriggers += 1;
    }
  }

  assert.equal(
    shockwaveTriggers,
    4,
    `Expected all 4 beats to trigger shockwaves, got ${shockwaveTriggers}`,
  );
});

test("kick sustain modulation envelope holds before releasing", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = new Float32Array(mock.analyser.frequencyBinCount);
  controller.status = "active";

  // Hit a kick at t = 0
  mock.setTone(55, -8);
  const hitLevels = controller.update(0);
  assert.ok(hitLevels.kick >= 0.55, "Kick envelope should spike on hit");
  assert.ok(hitLevels.kickOnset >= 0.55, "Kick onset should spike on hit");

  // Silence follows at t = 40 ms (within hold window of 45 ms)
  mock.setSilence();
  const holdLevels = controller.update(40);
  assert.ok(
    holdLevels.kick >= 0.5,
    "Kick modulation envelope should hold sustain across hold window",
  );
  assert.ok(
    holdLevels.kickOnset < 0.35,
    "Kick onset should decay rapidly to allow re-arming",
  );

  // At t = 150 ms (well into release)
  const releaseLevels = controller.update(150);
  assert.ok(
    releaseLevels.kick < holdLevels.kick,
    "Kick modulation envelope should release smoothly",
  );
  assert.ok(
    releaseLevels.kickOnset < 0.1,
    "Kick onset should be near zero",
  );
});

test("quiet audio is boosted by auto-gain within safe limits", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = new Float32Array(mock.analyser.frequencyBinCount);
  controller.status = "active";

  // Quiet track at -30 dBFS
  mock.setTone(65, -30);

  let levels = null;
  for (let frame = 0; frame <= 180; frame += 1) {
    levels = controller.update(frame * 16.666);
  }

  assert.ok(levels.hasSignal, "Quiet audio above noise floor should register as signal");
  assert.ok(
    levels.bass > 0.15,
    `Quiet audio should be scaled up to audible level, got bass = ${levels.bass}`,
  );
  assert.ok(
    levels.bass <= 1.0,
    "Quiet audio should not exceed unit clamp",
  );
});

test("fallback to frequencyData if floatFrequencyData is missing", () => {
  const controller = new RhythmController();
  const mock = createMockAudio();
  controller.context = mock.context;
  controller.analyser = mock.analyser;
  controller.frequencyData = new Uint8Array(mock.analyser.frequencyBinCount);
  controller.floatFrequencyData = null; // simulate environment without float buffer
  controller.status = "active";

  mock.setTone(60, -15);
  const levels = controller.update(100);
  assert.ok(levels.hasSignal);
  assert.ok(levels.bass > 0);
});
