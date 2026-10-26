import test from "node:test";
import assert from "node:assert/strict";
import {
  AcousticEmitter,
  colorForFrequencyBand,
  ACOUSTIC_INJECTION_MODES,
  ACOUSTIC_POSITION_MODES,
} from "../../assets/js/models/neural-growth/acoustic-emitter.js";

function createMockRhythm() {
  return {
    analyser: { fftSize: 2048 },
    context: { sampleRate: 48000 },
  };
}

test("colorForFrequencyBand maps octaves across chromatic spectrum", () => {
  assert.equal(colorForFrequencyBand(0), "#00f0ff"); // Sub-bass: Cyan
  assert.equal(colorForFrequencyBand(10), "#00ff66"); // Low-mids: Emerald
  assert.equal(colorForFrequencyBand(20), "#ffb800"); // High-mids: Gold
  assert.equal(colorForFrequencyBand(31), "#ff00a0"); // Treble: Magenta
});

test("AcousticEmitter initializes with valid defaults and constants", () => {
  const emitter = new AcousticEmitter();
  assert.equal(emitter.numBands, 32);
  assert.equal(emitter.cooldownMs, 120);
  assert.ok(ACOUSTIC_INJECTION_MODES.includes("dye"));
  assert.ok(ACOUSTIC_INJECTION_MODES.includes("shockwave"));
  assert.ok(ACOUSTIC_POSITION_MODES.includes("curve_peaks"));
});

test("calculateGridCoordinates respects position modes across simulation sizes", () => {
  const emitter = new AcousticEmitter();
  const size = 256;

  // Baseline mode: y fixed at 50%
  const baselineCoords = emitter.calculateGridCoordinates(0, 0.9, "baseline", size);
  assert.equal(baselineCoords.y, Math.round(0.50 * (size - 1)));

  // Curve peaks mode: y tracks level centered at 50%
  const peakCoords = emitter.calculateGridCoordinates(0, 0.8, "curve_peaks", size);
  const expectedY = Math.round((0.50 + (0.8 - 0.5) * 0.25) * (size - 1));
  assert.equal(peakCoords.y, expectedY);

  // Center mode: radial offset from center
  const centerCoords = emitter.calculateGridCoordinates(0, 0.5, "center", size, [0, 0]);
  assert.ok(centerCoords.x >= 0 && centerCoords.x < size);
  assert.ok(centerCoords.y >= 0 && centerCoords.y < size);
});

test("AcousticEmitter process ignores silent audio or mode off", () => {
  const emitter = new AcousticEmitter();
  const rhythm = createMockRhythm();
  const spectrum = new Uint8Array(1024).fill(200);
  const disturbances = [];
  const queueDisturbance = (...args) => disturbances.push(args);

  // Mode off
  const countOff = emitter.process(spectrum, { hasSignal: true }, 1000, {
    mode: "off",
    rhythmController: rhythm,
    queueDisturbance,
  });
  assert.equal(countOff, 0);
  assert.equal(disturbances.length, 0);

  // Silent signal
  const countSilent = emitter.process(spectrum, { hasSignal: false }, 1000, {
    mode: "dye",
    rhythmController: rhythm,
    queueDisturbance,
  });
  assert.equal(countSilent, 0);
  assert.equal(disturbances.length, 0);
});

test("AcousticEmitter triggers transient onsets and enforces cooldown and rate limits", () => {
  const emitter = new AcousticEmitter();
  const rhythm = createMockRhythm();
  emitter.buildFrequencyLut(48000, 2048);

  const spectrum = new Uint8Array(1024).fill(0);
  // Inject strong energy strictly in band 7 (bin 5)
  spectrum[5] = 240;

  const disturbances = [];
  const queueDisturbance = (x, y, radius, mode, opts) => {
    disturbances.push({ x, y, radius, mode, opts });
  };

  // First transient hit
  const count = emitter.process(spectrum, { hasSignal: true }, 1000, {
    mode: "dye",
    threshold: 0.3,
    rhythmController: rhythm,
    queueDisturbance,
  });

  assert.equal(count, 1);
  assert.equal(disturbances[0].mode, "dye");
  assert.ok(disturbances[0].opts.dyeColor);

  // Immediate subsequent frame (only 16ms later, cooldown is 120ms): should be blocked by cooldown
  const countImmediate = emitter.process(spectrum, { hasSignal: true }, 1016, {
    mode: "dye",
    threshold: 0.3,
    rhythmController: rhythm,
    queueDisturbance,
  });
  assert.equal(countImmediate, 0);

  // After cooldown (150ms later): can trigger again if new transient occurs in higher band
  for (let i = 10; i < 20; i += 1) spectrum[i] = 255;
  const countAfterCooldown = emitter.process(spectrum, { hasSignal: true }, 1200, {
    mode: "shockwave",
    threshold: 0.2,
    rhythmController: rhythm,
    queueDisturbance,
  });
  assert.ok(countAfterCooldown > 0);
  assert.equal(disturbances[disturbances.length - 1].mode, "shockwave");
});
