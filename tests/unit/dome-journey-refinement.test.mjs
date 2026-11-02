import test from "node:test";
import assert from "node:assert/strict";
import * as tf from "@tensorflow/tfjs";
import { optimizeDomeDream } from "../../assets/js/models/dome-dream-optimizer.js";
import { DomeDreamBaker } from "../../assets/js/models/inception-dream-bake.js";

test("coarse refinement carries fine source detail through a zero-update octave transition", async () => {
  await tf.setBackend("cpu");
  const width = 320,
    height = 160,
    data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v =
        0.45 +
        0.17 *
          Math.sin((x * Math.PI * 2) / 7) *
          Math.cos((y * Math.PI * 2) / 9) +
        0.07 * Math.sin((x * Math.PI * 2) / 3);
      data.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  const seed = tf.tensor4d(data, [1, height, width, 3]),
    baseline = tf.memory().numTensors;
  try {
    const result = await optimizeDomeDream(tf, { execute: (x) => x }, seed, {
      node: "identity",
      channel: 0,
      iterations: 4,
      stepSize: 0,
      preserveDetail: true,
      photoRect: null,
    });
    let maximum = 0;
    for (let y = 20; y < height - 20; y++)
      for (let x = 20; x < width - 20; x++) {
        const i = y * width + x;
        maximum = Math.max(
          maximum,
          Math.abs(result.rgba[i * 4] - Math.round(data[i * 3] * 255)),
        );
      }
    assert.ok(maximum <= 1, `Fine detail changed by ${maximum} bytes`);
    assert.deepEqual(result.sizes, [
      [80, 160],
      [160, 320],
    ]);
    assert.equal(tf.memory().numTensors, baseline);
    const controller = new AbortController();
    await assert.rejects(
      optimizeDomeDream(tf, { execute: (x) => x }, seed, {
        node: "identity",
        channel: 0,
        iterations: 4,
        preserveDetail: true,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      { name: "AbortError" },
    );
    assert.equal(tf.memory().numTensors, baseline);
  } finally {
    seed.dispose();
  }
});

test("travel bakes reuse one worker, pass refinement settings, and cancel stale jobs", async () => {
  const workers = [];
  const baker = new DomeDreamBaker({
    persistent: true,
    capture: async () => ({ close() {} }),
    createWorker: () => {
      const worker = {
        messages: [],
        postMessage(data) {
          this.messages.push(data);
        },
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const options = { stepSize: 0.012, preserveDetail: true, photoRect: null };
  for (let i = 0; i < 2; i++) {
    const pending = baker.bake({}, "mixed_6a", 42, 4, options);
    await settle();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages[i].keepAlive, true);
    assert.equal(workers[0].messages[i].preserveDetail, true);
    workers[0].onmessage({ data: { type: "result", iterations: 4 } });
    await pending;
    assert.equal(workers[0].terminated, undefined);
  }
  const cancelled = baker.bake({}, "mixed_6a", 42, 4, options);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  await settle();
  baker.cancel();
  await rejected;
  assert.equal(workers[0].terminated, true);
  assert.equal(baker.worker, null);
});
