import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/#experiments");
});

test("DigiFace executes the bundled decoder with WASM fallback", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  for (const [asset, expected] of [
    ["/LICENSE", "MIT License"],
    ["/licenses/digiface-decoder-research.txt", "non-commercial research only"],
    ["/models/digiface/NOTICE.txt", "DIGIFACE MODEL NOTICE"],
  ]) {
    const response = await request.get(asset);
    expect(response).toBeOK();
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(await response.text()).toContain(expected);
  }
  const result = await page.evaluate(async () => {
    const { DigiFaceVaeModel } =
      await import("/assets/js/models/digiface-vae.js");
    const { defaultParameters } =
      await import("/assets/js/core/model-contract.js");
    const model = new DigiFaceVaeModel();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const checked = await model.selfCheck();
    const frame = await model.render(canvas, defaultParameters(model));
    await model.dispose();
    return { checked, state: frame.modelMetrics.modelState };
  });
  expect(result.checked.outputShape).toEqual([1, 3, 112, 112]);
  expect(result.state).toBe("READY");
});

test("local neural inference loads committed browser weights", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const result = await page.evaluate(async () => {
    const { ensureTensorFlow } =
      await import("/assets/js/training/tf-runtime.js");
    const { NeuralModelStore } =
      await import("/assets/js/core/neural-model-store.js");
    const { LocalNeuralModel } =
      await import("/assets/js/models/local-neural.js");
    const { defaultParameters } =
      await import("/assets/js/core/model-contract.js");
    const tf = await ensureTensorFlow();
    const input = tf.input({ shape: [64] });
    const pixels = tf.layers
      .dense({ units: 3, activation: "sigmoid" })
      .apply(input);
    const image = tf.layers.reshape({ targetShape: [1, 1, 3] }).apply(pixels);
    const output = tf.layers.upSampling2d({ size: [128, 128] }).apply(image);
    const decoder = tf.model({ inputs: input, outputs: output });
    const encoderInput = tf.input({ shape: [128, 128, 3] });
    const pooled = tf.layers.globalAveragePooling2d({}).apply(encoderInput);
    const encoderOutput = tf.layers.dense({ units: 64 }).apply(pooled);
    const encoder = tf.model({ inputs: encoderInput, outputs: encoderOutput });
    await NeuralModelStore.save({
      encoder,
      decoder,
      metadata: {
        name: "TEST MODEL",
        profile: "datamosh",
        objective: "reconstruct",
        latentDim: 64,
        sampleNames: ["A"],
        sampleLatents: [Array(64).fill(0)],
        trainingSamples: 1,
      },
    });
    encoder.dispose();
    decoder.dispose();
    const model = new LocalNeuralModel();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const frame = await model.render(canvas, defaultParameters(model));
    const pixel = [...canvas.getContext("2d").getImageData(64, 64, 1, 1).data];
    model.dispose();
    return { status: frame.status, pixel };
  });
  expect(result.status).toBe("ready");
  expect(result.pixel.slice(0, 3)).toEqual([128, 128, 128]);
});

test("Inception graph gradients, ascent, and checkpoint resume remain connected", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const result = await page.evaluate(async () => {
    const { InceptionDreamModel } =
      await import("/assets/js/models/inception-dream.js");
    const { defaultParameters } =
      await import("/assets/js/core/model-contract.js");
    const model = new InceptionDreamModel();
    await model.ensureModel();
    const layers = model.resolveTargetNodes();
    const tf = globalThis.tf;
    model.workingWidth = model.workingHeight = 128;
    model.sourceTensor = tf.randomUniform(
      [1, 128, 128, 3],
      0,
      1,
      "float32",
      42,
    );
    model.sourceLoaded = true;
    model.parameters = {
      ...defaultParameters(model),
      pipelineMode: "multi_octave_preview",
      octaveCount: 3,
      stepsPerOctave: 10,
    };
    model.synchronizeDreamConfiguration(model.parameters);
    model.mode = "dream";
    model.clockEnabled = true;
    const tensorsBefore = tf.memory().numTensors;
    const originalNextFrame = tf.nextFrame;
    // Stop after one real gradient step; no graph or gradient math is mocked.
    tf.nextFrame = async () => {
      model.stop();
    };
    model.start();
    await model.waitForIdle();
    tf.nextFrame = originalNextFrame;
    const checkpoint = model.octaveCheckpoint;
    const firstStep = model.stepCount;
    const retained = Boolean(checkpoint) && checkpoint.nextStep === 2;
    tf.nextFrame = async () => {
      model.stop();
    };
    model.start();
    await model.waitForIdle();
    tf.nextFrame = originalNextFrame;
    const resumedStep = model.stepCount;
    const extraTensors = tf.memory().numTensors - tensorsBefore;
    await model.dispose();
    return { layers, firstStep, retained, resumedStep, extraTensors };
  });
  expect(result.layers).toHaveLength(2);
  expect(result.layers.every((node) => node.endsWith("/concat"))).toBe(true);
  expect(result.firstStep).toBe(1);
  expect(result.retained).toBe(true);
  expect(result.resumedStep).toBe(2);
  expect(result.extraTensors).toBeLessThanOrEqual(2);
});
