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
  clampDreamChannel,
} from "../../assets/js/models/neural-growth/inception-layers.js";
import {
  NeuronPreviewProvider,
  generateNeuronPreview,
} from "../../assets/js/models/neural-growth/neuron-preview-provider.js";
import { CURATED_NEURONS } from "../../assets/js/models/neural-growth/neuron-archetypes.js";

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

test("preview cache deduplicates concurrent requests, survives model-ready notifications and notifies once per channel", async (context) => {
  const calls = [];
  const graph = {};
  const bridge = new NeuronPreviewProvider({
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
  bridge.onModelReady(graph);
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

test("requested previews yield to standalone feature ascent and disposal cancels a waiting preview", async () => {
  let steps = 0;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const owner = { model: {}, isRunning: true };
  const bridge = new NeuronPreviewProvider({
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
  const bridge = new NeuronPreviewProvider({
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
  const bridge = new NeuronPreviewProvider({
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
  const bridge = new NeuronPreviewProvider({
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
  const bridge = new NeuronPreviewProvider({
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

test("shared preview endpoints and curated targets use exact channel bounds", () => {
  assert.equal(CURATED_NEURONS.length, 7);
  assert.equal(new Set(CURATED_NEURONS.map((n) => n.id)).size, 7);
  assert.deepEqual(
    Object.keys(INCEPTION_LAYERS),
    Object.keys(INCEPTION_LAYER_CHANNELS),
  );
  for (const [layer, depth] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
    assert.equal(clampDreamChannel(9999, layer), depth - 1);
    assert.equal(clampDreamChannel(-1, layer), -1);
  }
  for (const { layer, channel } of CURATED_NEURONS)
    assert.equal(clampDreamChannel(channel, layer), channel);
});

test("all requested stem endpoints exist in the exact bundled graph", async () => {
  const graph = JSON.parse(
    await readFile(
      new URL("../../models/inception/model.json", import.meta.url),
      "utf8",
    ),
  );
  const nodes = new Set(graph.modelTopology.node.map((node) => node.name));
  const weights = graph.weightsManifest.flatMap((group) => group.weights);
  for (const [stem, channels] of [
    ["Conv2d_2b_3x3", 64],
    ["Conv2d_3b_1x1", 80],
    ["Conv2d_4a_3x3", 192],
  ]) {
    assert.ok(nodes.has(INCEPTION_LAYERS[stem]));
    assert.equal(
      weights.find(
        (weight) => weight.name === `module/InceptionV3/${stem}/weights`,
      ).shape[3],
      channels,
    );
  }
});
