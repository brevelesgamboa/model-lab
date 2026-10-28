import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLfo,
  lfoPhaseAt,
  rateFromPosition,
  positionFromRate,
  defaultLfoConfig,
} from "../../assets/js/core/lfo.js";
import { displayMessage } from "../../assets/js/ui/messages.js";
import { coerceRangeValue } from "../../assets/js/app/controls-controller.js";
import {
  applyAudioModulation,
  updateModulationBounds,
} from "../../assets/js/core/modulation-matrix.js";
import { createGrowthController } from "../../assets/js/app/growth-controller.js";

test("signed modulation brackets cover the actual LFO and audio extrema", () => {
  const definition = { type: "range", min: 0, max: 100 };
  const config = {
    enabled: true,
    waveform: "sine",
    rate: 1,
    depth: 0.2,
    phase: 0,
  };
  const result = {};
  for (const depth of [-0.5, 0, 0.5]) {
    for (const base of [5, 50, 95]) {
      const values = [];
      for (const time of [0.25, 0.75]) {
        for (const level of [0, 1]) {
          values.push(
            applyAudioModulation(
              definition,
              applyLfo(definition, base, config, time),
              { source: "kick", depth },
              { kick: level },
            ),
          );
        }
      }
      assert.equal(
        updateModulationBounds(result, definition, base, config.depth, depth),
        result,
      );
      assert.equal(result.leftPercent, Math.min(...values));
      assert.equal(
        result.leftPercent + result.widthPercent,
        Math.max(...values),
      );
    }
  }
  updateModulationBounds(result, definition, 50, 0.2, -0.5);
  assert.equal(result.leftPercent, 15);
  assert.equal(result.widthPercent, 45);
  updateModulationBounds(result, definition, 50, 0, 0);
  assert.equal(result.widthPercent, 0);
  updateModulationBounds(result, { min: 1, max: 1 }, 1, 1, -1);
  assert.deepEqual(result, { leftPercent: 0, widthPercent: 0 });
});

test("the playhead phase uses the same clock, offset and rate limits as the oscillator", () => {
  const definition = { type: "range", min: 0, max: 100 };
  const config = {
    enabled: true,
    waveform: "sine",
    rate: 0.5,
    depth: 0.4,
    phase: 0.125,
  };
  for (const time of [-5, 0, 0.25, 2, 1234]) {
    const phase = lfoPhaseAt(config, time);
    assert.ok(phase >= 0 && phase < 1);
    const expected = 50 + Math.sin(phase * Math.PI * 2) * 20;
    assert.ok(
      Math.abs(applyLfo(definition, 50, config, time) - expected) < 1e-9,
    );
  }
  assert.equal(lfoPhaseAt({ ...config, rate: 100, phase: 0 }, 0.03125), 0.25);
});

test("the production audio handler ignores paused effects even when saved parameters enable them", (context) => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();
  context.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const shockwaves = [];
  const inputs = [];
  const coupled = [];
  const camera = [];
  const spectrumReads = [];
  const model = {
    id: "neural-growth",
    ready: true,
    isClockRunning: true,
    parameters: { beatShockwave: "on" },
    triggerBeatShockwave: (mode) => shockwaves.push(mode),
    triggerKickInput: (strength, time) => {
      inputs.push([strength, time]);
      return true;
    },
    processAcousticInjection: (...args) => coupled.push(args),
    processCameraMotion: (...args) => camera.push(args),
  };
  const controller = createGrowthController({
    elements: {},
    getModel: () => model,
    getView: () => "lab",
  });
  context.after(() => controller.dispose());
  controller.onAudioFrame({ hasSignal: true, kickOnset: 0.8 }, 1000, {
    getFrequencyData: () => spectrumReads.push(true),
  });
  controller.onAudioFrame({ hasSignal: true, kickOnset: 0.8 }, 1050);
  controller.onAudioFrame({ hasSignal: false }, 1200);
  controller.onAudioFrame({ hasSignal: true, kickOnset: 0.75 }, 1300);
  model.parameters.beatShockwave = "off";
  controller.onAudioFrame({ hasSignal: false }, 1500);
  controller.onAudioFrame({ hasSignal: true, kickOnset: 0.9 }, 1600);
  model.isClockRunning = false;
  controller.onAudioFrame({ hasSignal: false }, 1800);
  controller.onAudioFrame({ hasSignal: true, kickOnset: 0.9 }, 1900);
  assert.deepEqual(inputs, []);
  assert.deepEqual(shockwaves, []);
  assert.deepEqual(coupled, []);
  assert.deepEqual(camera, []);
  assert.deepEqual(spectrumReads, []);
});

test("one-sided LFOs stay on the selected side and match their displayed bounds", () => {
  const definition = { type: "range", min: 0, max: 100 };
  const bounds = {};
  for (const waveform of ["sine", "triangle", "saw", "square"]) {
    for (const polarity of ["bipolar", "positive", "negative"]) {
      const config = {
        enabled: true,
        rate: 1,
        phase: 0,
        depth: 0.8,
        waveform,
        polarity,
      };
      for (const base of [0, 5, 50, 95, 100]) {
        updateModulationBounds(
          bounds,
          definition,
          base,
          config.depth,
          0,
          polarity,
        );
        const values = Array.from({ length: 1000 }, (_, i) =>
          applyLfo(definition, base, config, i / 1000),
        );
        assert.ok(Math.min(...values) >= bounds.leftPercent - 1e-9);
        assert.ok(
          Math.max(...values) <=
            bounds.leftPercent + bounds.widthPercent + 1e-9,
        );
        if (polarity === "positive") assert.ok(Math.min(...values) >= base);
        if (polarity === "negative") assert.ok(Math.max(...values) <= base);
      }
    }
  }
});

test("modulated angular endpoints stay at the bracket edge while manual entry can wrap", () => {
  const definition = { type: "range", min: 0, max: 360, step: 1, wrap: true };
  const config = {
    ...defaultLfoConfig(),
    enabled: true,
    rate: 1,
    depth: 1,
    polarity: "positive",
  };
  const peak = applyLfo(definition, 180, config, 0.25);
  assert.equal(coerceRangeValue(definition, peak, false), 360);
  assert.equal(coerceRangeValue(definition, 360), 0);
});

test("slow and full logarithmic rate ranges round-trip existing rates", () => {
  assert.equal(defaultLfoConfig().rate, 0.05);
  for (const maximum of [0.5, 8]) {
    for (const rate of [0.005, 0.015, 0.05, 0.1, maximum]) {
      assert.ok(
        Math.abs(
          rateFromPosition(positionFromRate(rate, maximum), maximum) - rate,
        ) < 1e-9,
      );
    }
  }
  assert.ok(Math.abs(rateFromPosition(0.5) - 0.05) < 1e-9);
});

test("status and log messages use sentence case and preserve technical identifiers", () => {
  assert.equal(displayMessage("PARAMETERS RESET"), "Parameters reset");
  assert.equal(
    displayMessage("RE-EXTRACTING SOBEL CONTOURS..."),
    "Re-extracting Sobel contours...",
  );
  assert.equal(displayMessage("Neural Growth READY"), "Neural Growth ready");
  assert.equal(
    displayMessage("PNG EXPORTED (768 × 768)"),
    "PNG exported (768 × 768)",
  );
  assert.equal(displayMessage("RUN-000001 RESTORED"), "RUN-000001 restored");
  assert.equal(
    displayMessage("FILE /models/CHECKPOINT.json NOT FOUND"),
    "File /models/CHECKPOINT.json not found",
  );
  assert.equal(
    displayMessage("GPU MODEL INCEPTIONV3 READY"),
    "GPU model InceptionV3 ready",
  );
});
