import test from "node:test";
import assert from "node:assert/strict";
import { AsyncCanvasMetrics } from "../../assets/js/core/async-canvas-metrics.js";

test("async display metrics retain capture provenance and reject obsolete worker completions", async (context) => {
  const previousBitmap = globalThis.createImageBitmap,
    previousWorker = globalThis.Worker;
  context.after(() => {
    globalThis.createImageBitmap = previousBitmap;
    globalThis.Worker = previousWorker;
  });
  let captures = 0,
    notifications = 0;
  globalThis.createImageBitmap = async () => {
    captures++;
    return { close() {} };
  };
  globalThis.Worker = class {
    postMessage(message) {
      this.message = message;
    }
    terminate() {
      this.terminated = true;
    }
  };
  const metrics = new AsyncCanvasMetrics(() => notifications++);
  metrics.read({}, true, {
    modelId: "neural-growth",
    generation: 7,
    steps: 90,
    timestamp: 10,
    frameId: 3,
  });
  await Promise.resolve();
  const first = metrics.worker;
  first.onmessage({
    data: {
      id: first.message.id,
      metrics: { signalMean: 0.5, signalDeviation: 0.1 },
    },
  });
  assert.equal(metrics.sample.generation, 7);
  assert.equal(metrics.sample.frameId, 3);
  assert.equal(metrics.sample.timestamp, 10);
  assert.equal(metrics.sample.metrics.signalDeviation, 0.1);
  for (let i = 0; i < 20; i++) metrics.read({}, false);
  assert.equal(captures, 1, "cached reads must not capture additional frames");
  metrics.reset();
  metrics.read({}, true, {
    modelId: "neural-growth",
    generation: 8,
    frameId: 4,
  });
  await Promise.resolve();
  first.onmessage({
    data: { id: first.message.id, metrics: { signalMean: 0 } },
  });
  assert.equal(metrics.sample, null);
  assert.equal(notifications, 1);
  const current = metrics.worker;
  current.onmessage({
    data: { id: current.message.id, metrics: { signalMean: 1 } },
  });
  assert.equal(metrics.sample.generation, 8);
  assert.equal(notifications, 2);
  metrics.reset();
});
