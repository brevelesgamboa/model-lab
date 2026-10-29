import test from "node:test";
import assert from "node:assert/strict";
import * as tf from "@tensorflow/tfjs";
import {
  prepare360Pixels,
  photoProtection,
  projectPhotoMap,
} from "../../assets/js/models/equirectangular-canvas.js";
import {
  optimizeDomeDream,
  rollDomeX,
} from "../../assets/js/models/dome-dream-optimizer.js";
import {
  cachedModelFetch,
  inspectModelCache,
  INCEPTION_MODEL_URL,
  DEPTH_MODEL_URLS,
} from "../../assets/js/core/local-model-cache.js";
import { DomeDreamBaker } from "../../assets/js/models/inception-dream-bake.js";

function photo(w = 32, h = 24) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data.set([60 + x * 3, 80 + y * 3, 110, 255], (y * w + x) * 4);
  return data;
}

test("border-seeded panoramas are deterministic, low frequency, opaque, feathered, and closed at the rear and poles", () => {
  const input = photo(),
    p = prepare360Pixels(input, 32, 24, 192, 96),
    again = prepare360Pixels(input, 32, 24, 192, 96);
  assert.deepEqual(p.data, again.data);
  assert.ok(p.photoRect.width <= 192 / 3 + 1);
  let maxStep = 0;
  for (let y = 0; y < 96; y++) {
    for (let c = 0; c < 3; c++)
      assert.equal(p.data[y * 192 * 4 + c], p.data[(y * 192 + 191) * 4 + c]);
    for (let x = 0; x < 192; x++) {
      const off = (y * 192 + x) * 4;
      assert.equal(p.data[off + 3], 255);
      if (y === 0 || y === 95)
        assert.deepEqual(
          [...p.data.slice(off, off + 3)],
          [...p.data.slice(y * 192 * 4, y * 192 * 4 + 3)],
        );
      if (x > 0 && !photoProtection(x, y, p.photoRect))
        for (let c = 0; c < 3; c++)
          maxStep = Math.max(
            maxStep,
            Math.abs(p.data[off + c] - p.data[off - 4 + c]),
          );
    }
  }
  assert.ok(maxStep < 12);
  const mid = (48 * 192 + 96) * 4;
  assert.ok(p.data[mid] > 90 && p.data[mid] < 120);
  assert.throws(() => prepare360Pixels(input, 32, 24, 100, 100), RangeError);
  const projected = projectPhotoMap(
    new Float32Array([0, 1, 0, 1]),
    2,
    2,
    p.photoRect,
    192,
    96,
  );
  assert.ok(projected.depth.some((n) => n > 0));
  assert.ok(
    projected.depth.every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
  );
  for (let y = 0; y < projected.height; y++)
    assert.equal(
      projected.depth[y * projected.width],
      projected.depth[(y + 1) * projected.width - 1],
    );
});

test("periodic ascent changes the surrounding field, preserves the photo, closes seams and disposes all iteration tensors", async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  const p = prepare360Pixels(photo(), 32, 24, 192, 96);
  const seed = tf.tidy(() =>
    tf
      .tensor3d(p.data, [96, 192, 4])
      .slice([0, 0, 0], [96, 192, 3])
      .toFloat()
      .div(255)
      .expandDims(0),
  );
  const filter = tf.tensor4d(
    [
      1, -1, 0, -1, 1, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0,
    ],
    [3, 3, 3, 1],
  );
  const model = {
    execute: (input) => tf.relu(tf.conv2d(input, filter, 1, "same")),
  };
  const count = tf.memory().numTensors,
    progress = [];
  const result = await optimizeDomeDream(tf, model, seed, {
    node: "fixture",
    channel: 0,
    photoRect: p.photoRect,
    iterations: 4,
    onProgress: (n) => progress.push(n),
  });
  assert.equal(tf.memory().numTensors, count);
  assert.deepEqual(progress, [25, 50, 75, 100]);
  assert.equal(result.iterations, 4);
  let changed = 0,
    protectedCount = 0;
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 192; x++) {
      const off = (y * 192 + x) * 4;
      if (photoProtection(x, y, p.photoRect) === 1) {
        assert.deepEqual(
          [...result.rgba.slice(off, off + 3)],
          [...p.data.slice(off, off + 3)],
        );
        protectedCount++;
      } else if (x < 40)
        for (let c = 0; c < 3; c++)
          changed += Math.abs(result.rgba[off + c] - p.data[off + c]);
      if (x === 0)
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(
              result.rgba[off + c] - result.rgba[(y * 192 + 191) * 4 + c],
            ) < 24,
          );
    }
  assert.ok(protectedCount > 0);
  assert.ok(changed > 1000);
  const shifted = tf.tidy(() => rollDomeX(tf, rollDomeX(tf, seed, 31), -31));
  assert.deepEqual(await shifted.data(), await seed.data());
  shifted.dispose();
  const abort = new AbortController();
  await assert.rejects(
    optimizeDomeDream(tf, model, seed, {
      node: "fixture",
      channel: 0,
      photoRect: p.photoRect,
      iterations: 4,
      signal: abort.signal,
      onProgress: () => abort.abort(),
    }),
    { name: "AbortError" },
  );
  assert.equal(tf.memory().numTensors, count);
  await assert.rejects(
    optimizeDomeDream(
      tf,
      {
        execute: () => {
          throw new Error("Failed gradient fixture");
        },
      },
      seed,
      { node: "fixture", channel: 0, photoRect: p.photoRect, iterations: 2 },
    ),
    /Failed gradient fixture/,
  );
  assert.equal(tf.memory().numTensors, count);
  seed.dispose();
  filter.dispose();
});

test("model cache availability requires every manifest shard and both pinned depth files, and cached fetch works without network", async () => {
  const saved = new Map();
  let fetches = 0;
  const cache = {
    async match(key) {
      return saved.get(typeof key === "string" ? key : key.url)?.clone();
    },
    async put(key, response) {
      saved.set(typeof key === "string" ? key : key.url, response);
    },
  };
  const storage = { open: async () => cache };
  const fetcher = async () => {
    fetches++;
    return new Response("weights", { status: 200 });
  };
  await cachedModelFetch(
    "https://test.invalid/model.bin",
    {},
    { storage, fetcher },
  );
  const hit = await cachedModelFetch(
    "https://test.invalid/model.bin",
    {},
    {
      storage,
      fetcher: () => {
        throw Error("Offline");
      },
    },
  );
  assert.equal(await hit.text(), "weights");
  assert.equal(fetches, 1);
  saved.set(
    INCEPTION_MODEL_URL,
    new Response(
      JSON.stringify({ weightsManifest: [{ paths: ["a.bin", "b.bin"] }] }),
    ),
  );
  saved.set(new URL("a.bin", INCEPTION_MODEL_URL).href, new Response("a"));
  saved.set(DEPTH_MODEL_URLS[0], new Response("graph"));
  let status = await inspectModelCache({ storage });
  assert.equal(status.inception.ready, false);
  assert.equal(status.inception.count, 2);
  assert.equal(status.depth.ready, false);
  saved.set(new URL("b.bin", INCEPTION_MODEL_URL).href, new Response("b"));
  saved.set(DEPTH_MODEL_URLS[1], new Response("weights"));
  status = await inspectModelCache({ storage });
  assert.equal(status.inception.ready, true);
  assert.equal(status.depth.ready, true);
  assert.equal((await inspectModelCache({ storage: null })).available, false);
  const online = await cachedModelFetch(
    "https://test.invalid/uncached",
    {},
    {
      storage: {
        open: async () => {
          throw Error("Quota");
        },
      },
      fetcher,
    },
  );
  assert.equal(online.ok, true);
});

test("cancelling or replacing dream jobs rejects stale results and closes bitmaps and workers", async () => {
  const captures = [],
    workers = [];
  const baker = new DomeDreamBaker({
    capture: () => new Promise((resolve) => captures.push(resolve)),
    createWorker: () => {
      const w = {
        postMessage() {},
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(w);
      return w;
    },
  });
  const canvas = {
    photoRect: { x: 20, y: 20, width: 20, height: 20, feather: 4 },
  };
  const first = baker.bake(canvas, "mixed_5b", 120, 15);
  const rejected = assert.rejects(first, { name: "AbortError" });
  await Promise.resolve();
  baker.cancel();
  let closed = false;
  captures[0]({
    close() {
      closed = true;
    },
  });
  await rejected;
  await Promise.resolve();
  assert.equal(closed, true);
  assert.equal(workers.length, 0);
  const second = baker.bake(canvas, "mixed_5b", 120, 15);
  await Promise.resolve();
  captures[1]({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  const bitmap = {
    close() {
      this.closed = true;
    },
  };
  workers[0].onmessage({ data: { type: "result", bitmap, iterations: 15 } });
  assert.equal((await second).bitmap, bitmap);
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { type: "result", bitmap } });
  assert.equal(bitmap.closed, true);
  assert.equal(baker.pending, null);
});
