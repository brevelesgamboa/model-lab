import test from "node:test";
import assert from "node:assert/strict";
import {
  INCEPTION_LAYERS,
  DREAM_GUIDANCE_DEFAULTS,
  phenotypeBytesToFloatRgb,
  gradientDataToRgbaBytes,
  applySpatialGradientSmoothing,
  DreamGuidanceBridge,
} from "../../assets/js/models/neural-growth/dream-guidance.js";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";

test("DREAM_GUIDANCE_DEFAULTS and INCEPTION_LAYERS define valid configuration", () => {
  assert.equal(DREAM_GUIDANCE_DEFAULTS.enabled, "off");
  assert.equal(DREAM_GUIDANCE_DEFAULTS.strength, 0.0);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.cadence, 8);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.targetLayer, "mixed_6c");
  assert.equal(DREAM_GUIDANCE_DEFAULTS.targetChannel, -1);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.jitter, true);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.tvWeight, 0.005);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.chroma, 0.0);
  assert.equal(DREAM_GUIDANCE_DEFAULTS.resolution, 192);

  assert.ok(INCEPTION_LAYERS.mixed_5b.includes("Mixed_5b"));
  assert.ok(INCEPTION_LAYERS.mixed_6a.includes("Mixed_6a"));
  assert.ok(INCEPTION_LAYERS.mixed_6c.includes("Mixed_6c"));
  assert.ok(INCEPTION_LAYERS.mixed_7b.includes("Mixed_7b"));
});

test("phenotypeBytesToFloatRgb correctly normalizes raw encoded bytes and handles spatial roll", () => {
  const width = 2;
  const height = 2;
  // 4 pixels * 4 channels (RGBA)
  // Layout (x, y):
  // (0, 0): [127, 127, 127] -> ~0.5
  // (1, 0): [255, 255, 255] -> 1.0
  // (0, 1): [0, 0, 0]       -> 0.0
  // (1, 1): [191, 64, 127]  -> [1.0, 0.0, 0.5]
  const bytes = new Uint8Array([
    127, 127, 127, 255, // (0, 0)
    255, 255, 255, 255, // (1, 0)
    0, 0, 0, 255,       // (0, 1)
    191, 64, 127, 255,  // (1, 1)
  ]);

  const floatRgb = phenotypeBytesToFloatRgb(bytes, width, height);
  assert.equal(floatRgb.length, width * height * 3);

  // Neutral pixel at (0, 0)
  assert.ok(Math.abs(floatRgb[0] - 0.5) < 0.01);
  assert.ok(Math.abs(floatRgb[1] - 0.5) < 0.01);
  assert.ok(Math.abs(floatRgb[2] - 0.5) < 0.01);

  // Max pixel at (1, 0)
  assert.equal(floatRgb[3], 1.0);
  assert.equal(floatRgb[4], 1.0);
  assert.equal(floatRgb[5], 1.0);

  // Min pixel at (0, 1)
  assert.equal(floatRgb[6], 0.0);
  assert.equal(floatRgb[7], 0.0);
  assert.equal(floatRgb[8], 0.0);

  // Test circular spatial roll by dx = 1, dy = 0
  // After shift, position (1, 0) should now contain the value originally at (0, 0)
  const rolled = phenotypeBytesToFloatRgb(bytes, width, height, 1, 0);
  assert.ok(Math.abs(rolled[3] - 0.5) < 0.01); // (1, 0) now holds original (0, 0)
  assert.equal(rolled[0], 1.0); // (0, 0) wrapped from original (1, 0)
});

test("gradientDataToRgbaBytes packs 3-channel flat data to RGBA and reverse unrolls", () => {
  const flat = new Uint8Array([127, 140, 110, 200, 50, 127]);
  const rgba = gradientDataToRgbaBytes(flat, 2, 1);
  assert.equal(rgba.length, 8);

  assert.equal(rgba[0], 127);
  assert.equal(rgba[1], 140);
  assert.equal(rgba[2], 110);
  assert.equal(rgba[3], 255);

  assert.equal(rgba[4], 200);
  assert.equal(rgba[5], 50);
  assert.equal(rgba[6], 127);
  assert.equal(rgba[7], 255);

  // Test reverse unroll by dx = 1, dy = 0 on 2x1 grid
  const unrolled = gradientDataToRgbaBytes(flat, 2, 1, 1, 0);
  // (0, 0) samples from (gx = 1): flat[3..5]
  assert.equal(unrolled[0], 200);
  assert.equal(unrolled[1], 50);
  assert.equal(unrolled[2], 127);
  // (1, 0) samples from (gx = 0): flat[0..2]
  assert.equal(unrolled[4], 127);
  assert.equal(unrolled[5], 140);
  assert.equal(unrolled[6], 110);

  // Test Float32 input [-1.0, 1.0] encoding
  const floatGrad = new Float32Array([-1.0, 0.0, 1.0, 0.5, -0.5, 0.0]);
  const floatRgba = gradientDataToRgbaBytes(floatGrad, 2, 1);
  assert.equal(floatRgba[0], 0);   // -1.0 -> 0
  assert.equal(floatRgba[1], 127); // 0.0 -> 127
  assert.equal(floatRgba[2], 254); // 1.0 -> 254
  assert.equal(floatRgba[3], 255);
});

test("applySpatialGradientSmoothing smooths impulse and conserves energy", () => {
  const w = 8;
  const h = 8;
  const grad = new Float32Array(w * h * 3);
  // Single spike at (4, 4) in red channel
  grad[(4 * w + 4) * 3] = 1.0;

  const smoothed = applySpatialGradientSmoothing(grad, w, h);
  assert.equal(smoothed.length, grad.length);

  // Center peak is dampened
  const centerVal = smoothed[(4 * w + 4) * 3];
  assert.ok(centerVal < 0.25);
  assert.ok(centerVal > 0.10);

  // Neighbors now have smooth non-zero energy
  assert.ok(smoothed[(4 * w + 5) * 3] > 0.05);
  assert.ok(smoothed[(5 * w + 4) * 3] > 0.05);

  // Sum of energy across the grid is conserved (within floating point error)
  let sumSrc = 0;
  let sumDst = 0;
  for (let i = 0; i < grad.length; i += 3) {
    sumSrc += grad[i];
    sumDst += smoothed[i];
  }
  assert.ok(Math.abs(sumSrc - sumDst) < 0.001);
});

test("DreamGuidanceBridge manages lifecycle and enforces busy lock", async () => {
  const mockModel = {
    execute: (x, _node) => x,
  };

  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: mockModel }),
  });

  assert.equal(bridge.isBusy, false);
  assert.equal(bridge.disposed, false);

  const model = await bridge.ensureModel();
  assert.equal(model, mockModel);

  // Momentum management
  bridge._prevGrad = new Float32Array([1, 2, 3]);
  bridge.resetMomentum();
  assert.equal(bridge._prevGrad, null);

  bridge.dispose();
  assert.equal(bridge.disposed, true);
  assert.equal(bridge._model, null);
  assert.equal(bridge._prevGrad, null);

  // Disposed bridge returns null on compute
  const result = await bridge.computeGradient(new Uint8Array(256 * 256 * 4), 256, 256);
  assert.equal(result, null);
});

test("NeuralGrowthModel exposes dream guidance controls and normalizes parameters", () => {
  const model = new NeuralGrowthModel();

  const enabledControl = model.controls.find((c) => c.key === "dreamEnabled");
  assert.ok(enabledControl);
  assert.equal(enabledControl.default, "off");

  const strengthControl = model.controls.find((c) => c.key === "dreamStrength");
  assert.ok(strengthControl);
  assert.equal(strengthControl.default, 0.0);
  assert.equal(strengthControl.modulation, false);

  const cadenceControl = model.controls.find((c) => c.key === "dreamCadence");
  assert.ok(cadenceControl);
  assert.equal(cadenceControl.default, 8);
  assert.equal(cadenceControl.modulation, false);

  const layerControl = model.controls.find((c) => c.key === "targetLayer");
  assert.ok(layerControl);
  assert.equal(layerControl.default, "mixed_6c");

  const channelControl = model.controls.find((c) => c.key === "targetChannel");
  assert.ok(channelControl);
  assert.equal(channelControl.default, -1);
  assert.equal(channelControl.modulation, false);
  assert.equal(channelControl.getGuidance(-1).tag, "all-neurons");
  assert.equal(channelControl.getGuidance(42).tag, "neuron #42");

  const jitterControl = model.controls.find((c) => c.key === "dreamJitter");
  assert.ok(jitterControl);
  assert.equal(jitterControl.default, "on");

  const tvControl = model.controls.find((c) => c.key === "dreamTvWeight");
  assert.ok(tvControl);
  assert.equal(tvControl.default, 0.005);
  assert.equal(tvControl.modulation, false);
  assert.equal(tvControl.getGuidance(0.0001).tag, "raw");
  assert.equal(tvControl.getGuidance(0.005).tag, "clean");
  assert.equal(tvControl.getGuidance(0.03).tag, "soft");

  const chromaControl = model.controls.find((c) => c.key === "dreamChroma");
  assert.ok(chromaControl);
  assert.equal(chromaControl.default, 0.0);
  assert.equal(chromaControl.modulation, false);
  assert.equal(chromaControl.getGuidance(0.0).tag, "structural");
  assert.equal(chromaControl.getGuidance(0.2).tag, "subtle");
  assert.equal(chromaControl.getGuidance(0.8).tag, "vivid");

  const foldControl = model.controls.find((c) => c.key === "foldCount");
  assert.ok(foldControl);
  assert.equal(foldControl.default, 6);
  assert.equal(foldControl.modulation, false);
  assert.equal(foldControl.getGuidance(8, { coordinateTransform: "kaleidoscope" }).tag, "8-fold");
  assert.equal(foldControl.getGuidance(8, { coordinateTransform: "cartesian" }).tag, "inactive");

  const momentumControl = model.controls.find((c) => c.key === "latentMomentum");
  assert.ok(momentumControl);
  assert.equal(momentumControl.default, 0.0);
  assert.equal(momentumControl.modulation, false);
  assert.equal(momentumControl.getGuidance(0.0).tag, "instant");
  assert.equal(momentumControl.getGuidance(0.3).tag, "moderate");
  assert.equal(momentumControl.getGuidance(0.7).tag, "heavy");

  // Normalization
  assert.equal(model.normalizeStoredParameter("dreamEnabled", "on"), "on");
  assert.equal(model.normalizeStoredParameter("dreamEnabled", true), "on");
  assert.equal(model.normalizeStoredParameter("dreamEnabled", "off"), "off");
  assert.equal(model.normalizeStoredParameter("dreamEnabled", false), "off");

  assert.equal(model.normalizeStoredParameter("dreamStrength", 0.35), 0.35);
  assert.equal(model.normalizeStoredParameter("dreamStrength", -0.5), 0.0);
  assert.equal(model.normalizeStoredParameter("dreamStrength", 1.8), 1.0);

  assert.equal(model.normalizeStoredParameter("dreamCadence", 8), 8);
  assert.equal(model.normalizeStoredParameter("dreamCadence", 0), 1);
  assert.equal(model.normalizeStoredParameter("dreamCadence", 64), 32);

  assert.equal(model.normalizeStoredParameter("targetLayer", "mixed_6a"), "mixed_6a");
  assert.equal(model.normalizeStoredParameter("targetLayer", "unknown"), "mixed_6c");

  assert.equal(model.normalizeStoredParameter("targetChannel", -1), -1);
  assert.equal(model.normalizeStoredParameter("targetChannel", 120), 120);
  assert.equal(model.normalizeStoredParameter("targetChannel", -10), -1);
  assert.equal(model.normalizeStoredParameter("targetChannel", 1000), 767);

  assert.equal(model.normalizeStoredParameter("dreamJitter", "on"), "on");
  assert.equal(model.normalizeStoredParameter("dreamJitter", true), "on");
  assert.equal(model.normalizeStoredParameter("dreamJitter", "off"), "off");
  assert.equal(model.normalizeStoredParameter("dreamJitter", false), "off");

  assert.equal(model.normalizeStoredParameter("dreamTvWeight", 0.012), 0.012);
  assert.equal(model.normalizeStoredParameter("dreamTvWeight", -0.05), 0.0);
  assert.equal(model.normalizeStoredParameter("dreamTvWeight", 0.2), 0.05);

  assert.equal(model.normalizeStoredParameter("dreamChroma", 0.4), 0.4);
  assert.equal(model.normalizeStoredParameter("dreamChroma", -0.2), 0.0);
  assert.equal(model.normalizeStoredParameter("dreamChroma", 1.5), 1.0);

  assert.equal(model.normalizeStoredParameter("foldCount", 8), 8);
  assert.equal(model.normalizeStoredParameter("foldCount", 1), 3);
  assert.equal(model.normalizeStoredParameter("foldCount", 20), 12);

  assert.equal(model.normalizeStoredParameter("latentMomentum", 0.5), 0.5);
  assert.equal(model.normalizeStoredParameter("latentMomentum", -0.2), 0.0);
  assert.equal(model.normalizeStoredParameter("latentMomentum", 1.5), 0.9);
});

test("NeuralGrowthModel forwards dream guidance and latent dynamics to runtime steps", () => {
  let lastStepOptions = null;
  const mockRuntime = {
    size: 256,
    seed: 1,
    steps: 0,
    disposed: false,
    step: (_count, options) => {
      lastStepOptions = options;
    },
    draw: () => {},
    restart: () => {},
    dispose: () => {},
    readPhenotypeRgb: () => new Uint8Array(256 * 256 * 4).fill(127),
    updateDreamGradient: () => {},
  };

  const model = new NeuralGrowthModel({
    createRuntime: () => mockRuntime,
  });

  // When disabled (default), dreamStrength is 0.0
  model.onParameterChange("dreamEnabled", "off");
  model.onParameterChange("dreamStrength", 0.25);
  model.onParameterChange("dreamChroma", 0.3);
  model.onParameterChange("foldCount", 8);
  model.onParameterChange("latentMomentum", 0.35);
  model._runtime = mockRuntime;
  model.step();

  assert.ok(lastStepOptions);
  assert.equal(lastStepOptions.dreamStrength, 0.0);
  assert.equal(lastStepOptions.dreamChroma, 0.3);
  assert.equal(lastStepOptions.foldCount, 8);
  assert.equal(lastStepOptions.latentMomentum, 0.35);

  // When enabled, dreamStrength is forwarded
  model.onParameterChange("dreamEnabled", "on");
  model.step();

  assert.ok(lastStepOptions);
  assert.equal(lastStepOptions.dreamStrength, 0.25);
  assert.equal(lastStepOptions.dreamChroma, 0.3);
  assert.equal(lastStepOptions.foldCount, 8);
  assert.equal(lastStepOptions.latentMomentum, 0.35);
});
