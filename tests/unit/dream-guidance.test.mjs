import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inceptionCheckpointSha256 } from "../../tools/model-assets.mjs";
import {
  NEURON_PREVIEW_RECIPE,
  createFourierImage,
  previewSeed,
} from "../../assets/js/models/neural-growth/neuron-preview.js";
import {
  INCEPTION_LAYERS,
  INCEPTION_LAYER_CHANNELS,
  DREAM_GUIDANCE_DEFAULTS,
  phenotypeBytesToFloatRgb,
  gradientDataToRgbaBytes,
  applySpatialGradientSmoothing,
  DreamGuidanceBridge,
  generateNeuronPreview,
} from "../../assets/js/models/neural-growth/dream-guidance.js";
import {
  NeuralGrowthModel,
  CURATED_NEURONS,
} from "../../assets/js/models/neural-growth.js";
import {
  sanitizeParameters,
  supportsModulation,
} from "../../assets/js/core/model-contract.js";

async function previewEnvironment(context) {
  const tf = await import("@tensorflow/tfjs");
  await tf.setBackend("cpu");
  await tf.ready();
  const previousTf = globalThis.tf;
  const previousDocument = globalThis.document;
  const rendered = [];
  globalThis.tf = {
    ...tf,
    browser: {
      toPixels: async (tensor) => {
        rendered.push({
          shape: tensor.shape,
          pixels: Array.from(await tensor.data()),
        });
      },
    },
  };
  globalThis.document = {
    createElement: () => ({
      toDataURL: (type, quality) => `data:${type};base64,preview-${quality}`,
    }),
  };
  context.after(() => {
    globalThis.tf = previousTf;
    globalThis.document = previousDocument;
  });
  return { tf, rendered };
}

test("preview ascent runs 30 bounded, yielding steps, encodes in memory and releases all tensors", async (context) => {
  const { tf, rendered } = await previewEnvironment(context);
  const baseline = tf.memory().numTensors;
  let passes = 0;
  let yields = 0;
  const slices = [];
  const graph = {
    execute(input, node) {
      assert.equal(node, INCEPTION_LAYERS.mixed_7b);
      assert.deepEqual(input.shape, [1, 96, 96, 3]);
      if (passes === 0) {
        const pixels = input.dataSync();
        assert.ok(pixels.every((value) => value >= -0.21 && value <= 0.21));
      }
      passes += 1;
      const act = input.square();
      const slice = act.slice.bind(act);
      act.slice = (begin, size) => {
        slices.push(begin[3]);
        return slice(begin, size);
      };
      return act;
    },
  };
  const url = await generateNeuronPreview(graph, "mixed_7b", 1800, 64, 30, {
    beforeStep: async () => {
      yields += 1;
    },
  });
  assert.match(url, /^data:image\/webp;/);
  assert.equal(passes, 30);
  assert.equal(yields, 30);
  assert.ok(slices.every((channel) => channel === 2));
  assert.deepEqual(rendered[0].shape, [64, 64, 3]);
  assert.ok(
    rendered[0].pixels.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ),
  );
  assert.equal(tf.memory().numTensors, baseline);
});

test("preview ensemble uses the bundled graph's own input normalization and no channel slice", async (context) => {
  const { tf, rendered } = await previewEnvironment(context);
  const baseline = tf.memory().numTensors;
  const graph = {
    executor: {
      graph: { nodes: { "module_apply_default/hub_input/Sub": {} } },
    },
    execute(input) {
      assert.ok(
        input.dataSync().every((value) => value >= 0.4 && value <= 0.6),
      );
      const act = input.mul(2).sub(1);
      act.slice = () => {
        throw new Error("Ensemble must not slice");
      };
      return [act];
    },
  };
  await generateNeuronPreview(graph, "mixed_6c", -1, 96, 1, {
    beforeStep: async () => {},
  });
  assert.deepEqual(rendered[0].shape, [96, 96, 3]);
  assert.equal(tf.memory().numTensors, baseline);
});

test("Fourier examples are reproducible by seed and release optimizer state", async (context) => {
  const { tf, rendered } = await previewEnvironment(context);
  const baseline = tf.memory().numTensors;
  const model = { execute: (input) => input.square() };
  for (const seed of [11, 11, 23]) {
    await generateNeuronPreview(model, "mixed_6c", 1, 8, 3, {
      seed,
      beforeStep: async () => {},
    });
    assert.equal(tf.memory().numTensors, baseline);
  }
  assert.deepEqual(rendered[0].pixels, rendered[1].pixels);
  assert.notDeepEqual(rendered[0].pixels, rendered[2].pixels);
});

test("the Fourier luminance coordinate moves RGB channels together", async (context) => {
  const { tf } = await previewEnvironment(context);
  const baseline = tf.memory().numTensors;
  const image = createFourierImage(tf, 4, 11);
  const coefficients = new Float32Array(3 * 4 * 4);
  coefficients[0] = 4;
  const pixels = tf.tidy(() =>
    Array.from(image.render(tf.tensor3d(coefficients, [3, 4, 4])).dataSync()),
  );
  assert.ok(
    pixels.every((value) => Number.isFinite(value) && value > 0.8 && value < 1),
  );
  assert.ok(Math.max(...pixels) - Math.min(...pixels) < 0.03);
  image.dispose();
  assert.equal(tf.memory().numTensors, baseline);
});

test("bundled previews match the app checkpoint, recipe, channels, and build assets", async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL("../../models/inception/previews/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../../tools/model-assets.json", import.meta.url),
      "utf8",
    ),
  );
  const graph = manifest.find(
    (entry) => entry.path === "models/inception/model.json",
  );
  assert.equal(catalog.modelSha256, graph.sha256);
  assert.equal(catalog.checkpointSha256, inceptionCheckpointSha256(manifest));
  assert.equal(catalog.recipe, NEURON_PREVIEW_RECIPE);
  assert.deepEqual(
    new Set(catalog.entries.map((entry) => `${entry.layer}_${entry.channel}`)),
    new Set(CURATED_NEURONS.map((entry) => `${entry.layer}_${entry.channel}`)),
  );
  for (const entry of catalog.entries) {
    assert.equal(entry.seed, previewSeed(entry.layer, entry.channel));
    const path = `models/inception/previews/${entry.file}`;
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
    const asset = manifest.find((item) => item.path === path);
    assert.ok(asset, `Missing production preview: ${path}`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
    );
  }
});

test("preview failures, encoding failures and cancellation dispose variables and intermediates", async (context) => {
  const { tf } = await previewEnvironment(context);
  const baseline = tf.memory().numTensors;
  const failing = {
    execute() {
      throw new Error("Invalid graph");
    },
  };
  await assert.rejects(
    generateNeuronPreview(failing, "mixed_6c", 3, 64, 1, {
      beforeStep: async () => {},
    }),
    /Invalid graph/,
  );
  assert.equal(tf.memory().numTensors, baseline);
  const graph = { execute: (input) => input.square() };
  const abort = new AbortController();
  await assert.rejects(
    generateNeuronPreview(graph, "mixed_6c", -1, 64, 30, {
      signal: abort.signal,
      beforeStep: async () => abort.abort(),
    }),
    { name: "AbortError" },
  );
  assert.equal(tf.memory().numTensors, baseline);
  globalThis.tf.browser.toPixels = async () => {
    throw new Error("Encoding failed");
  };
  await assert.rejects(
    generateNeuronPreview(graph, "mixed_6c", -1, 64, 1, {
      beforeStep: async () => {},
    }),
    /Encoding failed/,
  );
  assert.equal(tf.memory().numTensors, baseline);
});

test("preview cache deduplicates concurrent requests, survives resets and notifies once per channel", async (context) => {
  const calls = [];
  const graph = {};
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: graph }),
    generatePreview: async (model, layer, channel, size, steps) => {
      assert.equal(model, graph);
      assert.equal(size, 96);
      assert.equal(steps, 96);
      calls.push(`${layer}_${channel}`);
      return `data:image/webp;base64,${channel}`;
    },
  });
  context.after(() => bridge.dispose());
  const updates = [];
  const unsubscribe = bridge.subscribePreviews((key) => updates.push(key));
  const neurons = CURATED_NEURONS.slice(0, 2);
  const first = bridge.warmArchetypePreviews(neurons);
  const concurrent = bridge.warmArchetypePreviews([...neurons, ...neurons]);
  assert.equal(first, concurrent);
  assert.equal(await first, bridge.previewCache);
  assert.equal(bridge.previewCache.size, 2);
  bridge.resetMomentum();
  await bridge.warmArchetypePreviews(neurons);
  assert.deepEqual(
    calls,
    neurons.map(({ layer, channel }) => `${layer}_${channel}`),
  );
  assert.deepEqual(updates, calls);
  unsubscribe();
  bridge.dispose();
  assert.equal(bridge.previewCache.size, 0);
  assert.equal(bridge._previewListeners.size, 0);
});

test("requested previews yield to foreground guidance and disposal cancels a waiting preview", async () => {
  let steps = 0;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const owner = { model: {}, isRunning: true };
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => owner,
    archetypes: CURATED_NEURONS.slice(0, 1),
    generatePreview: async (
      _model,
      _layer,
      _channel,
      _size,
      _steps,
      { beforeStep },
    ) => {
      entered();
      await beforeStep();
      steps += 1;
      return "data:image/webp;base64,preview";
    },
  });
  bridge.onModelReady(owner.model);
  assert.equal(bridge._previewTask, null);
  const task = bridge.warmArchetypePreviews(CURATED_NEURONS.slice(0, 1));
  await started;
  assert.equal(steps, 0);
  owner.isRunning = false;
  bridge._isBusy = true;
  bridge.dispose();
  await task;
  assert.equal(steps, 0);
  assert.equal(bridge.previewCache.size, 0);
});

test("preview requests share work while each consumer can cancel independently", async (context) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: {} }),
    generatePreview: async () => {
      calls += 1;
      entered();
      await gate;
      return "shared-preview";
    },
  });
  context.after(() => bridge.dispose());
  const abort = new AbortController();
  const first = bridge.requestPreview("mixed_7b", 1800, {
    signal: abort.signal,
  });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = bridge.requestPreview("mixed_7b", 1800);
  await started;
  abort.abort();
  await rejected;
  release();
  assert.equal(await second, "shared-preview");
  assert.equal(await bridge.requestPreview("mixed_7b", 1800), "shared-preview");
  assert.equal(calls, 1);
});

function backgroundBridge(context, generatePreview) {
  const previewStorage = {
    enabled: true,
    available: true,
    save: async () => {},
    clear: async () => true,
    dispose() {},
  };
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: {} }),
    generatePreview,
    previewStorage,
  });
  bridge.loadPreviews = async () => bridge.previewCache;
  context.after(() => bridge.dispose());
  return bridge;
}

test("explicit background batches deduplicate targets, pause, and yield to foreground requests", async (context) => {
  const calls = [];
  const bridge = backgroundBridge(
    context,
    async (_model, _layer, channel, _size, _steps, { beforeStep }) => {
      await beforeStep();
      calls.push(channel);
      return `preview-${channel}`;
    },
  );
  assert.deepEqual(calls, []);
  bridge.previewCache.set("mixed_6c_0", "already-cached");
  const job = bridge.startBackgroundPreviews(
    [0, 1, 1, 2].map((channel) => ({ layer: "mixed_6c", channel })),
  );
  bridge.pauseBackgroundPreviews();
  assert.equal(await bridge.requestPreview("mixed_6c", 3), "preview-3");
  assert.deepEqual(calls, [3]);
  assert.equal(bridge.backgroundPreviewStatus.phase, "paused");
  bridge.pauseBackgroundPreviews(false);
  await job;
  assert.deepEqual(calls, [3, 1, 2]);
  assert.equal(bridge.backgroundPreviewStatus.total, 3);
  assert.equal(bridge.backgroundPreviewStatus.completed, 3);
  assert.equal(bridge.backgroundPreviewStatus.phase, "complete");
});

test("cancelling a background batch releases its active consumer and never starts later targets", async (context) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const calls = [];
  const bridge = backgroundBridge(
    context,
    async (_model, _layer, channel, _size, _steps, { signal }) => {
      calls.push(channel);
      entered();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  );
  const job = bridge.startBackgroundPreviews(
    [0, 1, 2].map((channel) => ({ layer: "mixed_6c", channel })),
  );
  await started;
  bridge.cancelBackgroundPreviews();
  await job;
  await bridge._previewTask;
  assert.deepEqual(calls, [0]);
  assert.equal(bridge.backgroundPreviewStatus.phase, "cancelled");
  assert.equal(bridge._previewEntries.size, 0);
  assert.equal(bridge._previewQueue.size, 0);
});

test("background batches record failed targets, continue, and clear stops paused work", async (context) => {
  const bridge = backgroundBridge(context, async (_model, _layer, channel) => {
    if (channel === 1) throw new Error("one bad target");
    return `preview-${channel}`;
  });
  await bridge.startBackgroundPreviews(
    [0, 1, 2].map((channel) => ({ layer: "mixed_6c", channel })),
  );
  assert.equal(bridge.backgroundPreviewStatus.phase, "complete");
  assert.equal(bridge.backgroundPreviewStatus.failed, 1);
  assert.equal(bridge.previewCache.get("mixed_6c_2"), "preview-2");
  const second = bridge.startBackgroundPreviews([
    { layer: "mixed_6c", channel: 4 },
  ]);
  bridge.pauseBackgroundPreviews();
  await bridge.clearSavedPreviews();
  await second;
  assert.equal(bridge.backgroundPreviewStatus.phase, "cancelled");
  assert.equal(bridge.previewCache.has("mixed_6c_4"), false);
});

test("a background batch stops after one failed model load", async (context) => {
  let loads = 0;
  let generated = 0;
  const bridge = backgroundBridge(context, async () => {
    generated += 1;
  });
  bridge.ensureModel = async () => {
    loads += 1;
    throw new Error("Model download failed");
  };
  await bridge.startBackgroundPreviews(
    Array.from({ length: 256 }, (_, channel) => ({
      layer: "mixed_5b",
      channel,
    })),
  );
  assert.equal(loads, 1);
  assert.equal(generated, 0);
  assert.equal(bridge.backgroundPreviewStatus.phase, "error");
  assert.equal(bridge._previewEntries.size, 0);
});

test("a selected channel preempts background generation and resumes its consumers", async (context) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const calls = [];
  const completed = [];
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: {} }),
    generatePreview: async (
      _model,
      _layer,
      channel,
      _size,
      _steps,
      { signal },
    ) => {
      calls.push(channel);
      if (calls.length === 1) {
        entered();
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }
      return `preview-${channel}`;
    },
  });
  context.after(() => bridge.dispose());
  bridge.subscribePreviews((key) => completed.push(key));
  const background = bridge.requestPreview("mixed_6c", 1, { priority: false });
  await started;
  const selected = bridge.requestPreview("mixed_6c", 2);
  assert.equal(await selected, "preview-2");
  assert.equal(await background, "preview-1");
  assert.deepEqual(calls, [1, 2, 1]);
  assert.deepEqual(completed, ["mixed_6c_2", "mixed_6c_1"]);
});

test("failed channel previews can retry and disposal settles queued requests", async (context) => {
  let calls = 0;
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: {} }),
    generatePreview: async () => {
      if (++calls === 1) throw new Error("temporary failure");
      return "recovered";
    },
  });
  context.after(() => bridge.dispose());
  await assert.rejects(
    bridge.requestPreview("mixed_5b", 255),
    /temporary failure/,
  );
  await assert.rejects(
    bridge.requestPreview("mixed_5b", 255),
    /temporary failure/,
  );
  assert.equal(calls, 1);
  assert.equal(
    await bridge.requestPreview("mixed_5b", 255, { retry: true }),
    "recovered",
  );
  await assert.rejects(
    bridge.requestPreview("mixed_5b", 256),
    /Unknown InceptionV3/,
  );
  await assert.rejects(
    bridge.requestPreview("mixed4a", 144),
    /Unknown InceptionV3/,
  );
  const pending = bridge.requestPreview("mixed_7c", 2047);
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  bridge.dispose();
  await cancelled;
  assert.equal(bridge._previewEntries.size, 0);
});

test("every Inception endpoint has its exact channel depth and a selectable control", () => {
  const model = new NeuralGrowthModel();
  assert.deepEqual(INCEPTION_LAYER_CHANNELS, {
    Conv2d_2b_3x3: 64,
    Conv2d_3b_1x1: 80,
    Conv2d_4a_3x3: 192,
    mixed_5b: 256,
    mixed_5c: 288,
    mixed_5d: 288,
    mixed_6a: 768,
    mixed_6b: 768,
    mixed_6c: 768,
    mixed_6d: 768,
    mixed_6e: 768,
    mixed_7a: 1280,
    mixed_7b: 2048,
    mixed_7c: 2048,
  });
  assert.deepEqual(
    Object.keys(INCEPTION_LAYERS),
    Object.keys(INCEPTION_LAYER_CHANNELS),
  );
  assert.deepEqual(
    model.controls
      .find((control) => control.key === "targetLayer")
      .options.map(({ value }) => value),
    Object.keys(INCEPTION_LAYER_CHANNELS),
  );
  for (const [layer, depth] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
    model.onParameterChange("targetLayer", layer);
    const control = model.controls.find(({ key }) => key === "targetChannel");
    assert.equal(control.max, depth - 1);
    assert.equal(
      model.normalizeStoredParameter("targetChannel", 9999),
      depth - 1,
    );
    assert.equal(model.normalizeStoredParameter("targetChannel", -1), -1);
  }
});

test("layer changes clamp channels without replacing runtime state or resetting the clock", () => {
  const model = new NeuralGrowthModel();
  const runtime = { steps: 42 };
  model._runtime = runtime;
  model._lastTick = 12;
  model._accumulator = 0.5;
  const epoch = model._epoch;
  model.onParameterChange("targetLayer", "mixed_7b");
  model.onParameterChange("targetChannel", 1800);
  assert.equal(model.parameters.targetChannel, 1800);
  model.onParameterChange("targetLayer", "mixed_5b");
  assert.equal(model.parameters.targetChannel, 255);
  assert.deepEqual(
    model.parameterDefaultsForChange("targetLayer", "mixed_5b"),
    { targetChannel: 255 },
  );
  model.onParameterChange("targetLayer", "mixed_7b");
  assert.equal(model.parameters.targetChannel, 255);
  assert.equal(model._runtime, runtime);
  assert.equal(runtime.steps, 42);
  assert.equal(model._lastTick, 12);
  assert.equal(model._accumulator, 0.5);
  assert.equal(model._epoch, epoch);
});

test("restoration resolves channel bounds from the incoming layer, independent of previous state", () => {
  const model = new NeuralGrowthModel();
  model.onParameterChange("targetLayer", "mixed_5b");
  const deep = sanitizeParameters(model, {
    targetLayer: "mixed_7b",
    targetChannel: 1800,
  });
  assert.equal(deep.targetChannel, 1800);
  model.onParameterChange("targetLayer", "mixed_7c");
  const shallow = sanitizeParameters(model, {
    ...deep,
    targetLayer: "mixed_5b",
  });
  assert.equal(shallow.targetChannel, 255);
  assert.equal(
    sanitizeParameters(model, { targetLayer: "toString", targetChannel: 1800 })
      .targetChannel,
    767,
  );
  assert.equal(
    sanitizeParameters(model, { targetChannel: -1 }).targetChannel,
    -1,
  );
});

test("curated neuron targets fit their layers and retain exactly 18 modulation routes", () => {
  const model = new NeuralGrowthModel();
  assert.equal(CURATED_NEURONS.length, 7);
  assert.equal(new Set(CURATED_NEURONS.map(({ id }) => id)).size, 7);
  for (const neuron of CURATED_NEURONS) {
    const params = sanitizeParameters(model, {
      targetLayer: neuron.layer,
      targetChannel: neuron.channel,
      dreamStrength: neuron.strength,
    });
    assert.equal(params.targetLayer, neuron.layer);
    assert.equal(params.targetChannel, neuron.channel);
    assert.equal(params.dreamStrength, neuron.strength);
    assert.equal(
      model
        .controlsForParameters(params)
        .filter((control) => supportsModulation(model, control)).length,
      18,
    );
  }
});

test("gradient ascent slices against the executing tensor shape, including ensemble and stale-layer requests", async (context) => {
  const tf = await import("@tensorflow/tfjs");
  await tf.setBackend("cpu");
  await tf.ready();
  const previous = globalThis.tf;
  globalThis.tf = tf;
  context.after(() => {
    globalThis.tf = previous;
  });
  let channels = 256;
  const slices = [];
  const nodes = [];
  const graph = {
    execute(input, node) {
      nodes.push(node);
      const activation = input
        .tile([1, 1, 1, Math.ceil(channels / 3)])
        .slice([0, 0, 0, 0], [-1, -1, -1, channels]);
      const slice = activation.slice.bind(activation);
      activation.slice = (begin, size) => {
        slices.push(begin[3]);
        return slice(begin, size);
      };
      return activation;
    },
  };
  const bridge = new DreamGuidanceBridge({
    getInceptionModel: () => ({ model: graph }),
  });
  context.after(() => bridge.dispose());
  const bytes = new Uint8Array([
    127, 150, 180, 255, 140, 160, 200, 255, 90, 80, 160, 255, 120, 210, 240,
    255,
  ]);
  const tensors = tf.memory().numTensors;
  for (const [layer, depth, requested, expected] of [
    ["mixed_5b", 256, 1800, 255],
    ["mixed_6c", 768, 1500, 767],
    ["mixed_7b", 2048, 1800, 1800],
    // Deliberately mismatch metadata: the actual activation must win.
    ["mixed_7b", 256, 1800, 255],
  ]) {
    channels = depth;
    const result = await bridge.computeGradient(
      bytes,
      2,
      2,
      layer,
      requested,
      false,
      0,
    );
    assert.equal(result.length, 16);
    assert.equal(slices.at(-1), expected);
    assert.equal(nodes.at(-1), INCEPTION_LAYERS[layer]);
  }
  const beforeEnsemble = slices.length;
  await bridge.computeGradient(bytes, 2, 2, "mixed_5b", -1, false, 0);
  assert.equal(slices.length, beforeEnsemble);
  assert.equal(tf.memory().numTensors, tensors);
});

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
    127,
    127,
    127,
    255, // (0, 0)
    255,
    255,
    255,
    255, // (1, 0)
    0,
    0,
    0,
    255, // (0, 1)
    191,
    64,
    127,
    255, // (1, 1)
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
  assert.equal(floatRgba[0], 0); // -1.0 -> 0
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
  assert.ok(centerVal > 0.1);

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
  const result = await bridge.computeGradient(
    new Uint8Array(256 * 256 * 4),
    256,
    256,
  );
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
  assert.equal(
    foldControl.getGuidance(8, { coordinateTransform: "kaleidoscope" }).tag,
    "8-fold",
  );
  assert.equal(
    foldControl.getGuidance(8, { coordinateTransform: "cartesian" }).tag,
    "inactive",
  );

  const momentumControl = model.controls.find(
    (c) => c.key === "latentMomentum",
  );
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

  assert.equal(
    model.normalizeStoredParameter("targetLayer", "mixed_6a"),
    "mixed_6a",
  );
  assert.equal(
    model.normalizeStoredParameter("targetLayer", "unknown"),
    "mixed_6c",
  );

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
