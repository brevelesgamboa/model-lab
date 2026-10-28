import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ExperimentStore } from "../../assets/js/core/experiment-store.js";
import {
  InceptionSensor,
  inceptionSensor,
} from "../../assets/js/models/neural-growth/inception-sensor.js";
import {
  applyAudioModulation,
  getModulationLevel,
  setAudioRoute,
  getAudioRoute,
  restoreAudioMatrix,
  audioMatrixForModel,
  hasModulationSource,
} from "../../assets/js/core/modulation-matrix.js";

function fixture(capture = async () => ({ close() {} })) {
  const messages = [];
  const worker = {
    postMessage: (message) => messages.push(message),
    terminate() {
      this.terminated = true;
    },
  };
  const sensor = new InceptionSensor({
    getCanvas: () => ({ width: 192, height: 192 }),
    createWorker: () => worker,
    capture,
  });
  const reply = (data) => worker.onmessage({ data });
  const ready = () => reply({ type: "ready", backend: "webgl", loadMs: 10 });
  const finish = (raw) =>
    reply({
      type: "sample",
      id: messages.at(-1).id,
      raw,
      downloadedValues: 1,
      retainedTensors: 0,
      inferenceMs: 3,
    });
  return { sensor, worker, messages, reply, ready, finish };
}

test("sensor cadence is at most 2 Hz and one capture/inference can be in flight", async () => {
  let release,
    closed = 0;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.sensor.start();
  assert.equal(f.sensor.update(0), false);
  f.ready();
  assert.equal(f.sensor.update(0), true);
  assert.equal(f.sensor.update(5000), false);
  release({ close: () => closed++ });
  await Promise.resolve();
  assert.equal(f.messages.at(-1).type, "observe");
  assert.equal(f.sensor.update(6000), false);
  f.finish(3);
  f.sensor.stop();
  f.sensor.start();
  assert.equal(f.sensor.update(499), false);
  assert.equal(f.sensor.update(500), true);
  assert.equal(f.messages.filter((m) => m.type === "observe").length, 1);
  f.sensor.stop();
  release({ close: () => closed++ });
  await Promise.resolve();
  assert.equal(closed, 1);
  assert.equal(f.sensor.getLevel(), 0);
  f.sensor.dispose();
});

test("target/source/stop invalidation rejects delayed results and preserves the busy guard", async () => {
  for (const invalidate of [
    (sensor) => sensor.setTarget("mixed_5b", 120),
    (sensor) => sensor.setSourceKey("new-canvas"),
    (sensor) => {
      sensor.stop();
      sensor.start();
    },
  ]) {
    const f = fixture();
    f.sensor.start();
    f.ready();
    f.sensor.update(0);
    await Promise.resolve();
    const first = f.messages.at(-1);
    invalidate(f.sensor);
    assert.equal(f.sensor.update(1000), false);
    f.reply({ type: "sample", id: first.id, raw: 9 });
    assert.equal(f.sensor.samples, 0);
    assert.equal(f.sensor.getLevel(), 0);
    assert.equal(f.sensor.update(1000), true);
    await Promise.resolve();
    f.finish(3);
    assert.equal(f.sensor.samples, 1);
    assert.equal(f.messages.filter((m) => m.type === "init").length, 1);
    f.sensor.dispose();
  }
});

test("constant features stay quiet, varying signed activations are bounded and smoothed", async () => {
  const f = fixture();
  f.sensor.start();
  f.ready();
  for (const [i, raw] of [-3, -3, -3].entries()) {
    f.sensor.update(i * 500);
    await Promise.resolve();
    f.finish(raw);
    assert.equal(f.sensor.getLevel(), 0);
  }
  f.sensor.update(1500);
  await Promise.resolve();
  f.finish(-1);
  assert.equal(f.sensor.getLevel(), 0.15);
  for (let i = 4; i < 20; i++) {
    f.sensor.update(i * 500);
    await Promise.resolve();
    f.finish(i % 2 ? -100 : 100);
    assert.ok(f.sensor.getLevel() >= 0 && f.sensor.getLevel() <= 1);
  }
  f.sensor.setTarget("Conv2d_2b_3x3", 999);
  assert.deepEqual(f.sensor.getTarget(), {
    layer: "Conv2d_2b_3x3",
    channel: 63,
  });
  assert.equal(f.sensor.samples, 0);
  assert.throws(() => f.sensor.setTarget("missing", 0), RangeError);
  f.sensor.dispose();
});

test("sensor errors publish zero, latch, and allow explicit retry without accepting old workers", async () => {
  const f = fixture();
  f.sensor.start();
  f.ready();
  f.sensor.update(0);
  await Promise.resolve();
  f.finish(NaN);
  assert.equal(f.sensor.getLevel(), 0);
  assert.equal(f.sensor.status, "error");
  assert.equal(f.sensor.update(5000), false);
  assert.equal(f.worker.terminated, true);
  const oldHandler = f.worker.onmessage;
  const replacement = { postMessage() {}, terminate() {} };
  f.sensor.createWorker = () => replacement;
  f.sensor.stop();
  f.sensor.start();
  oldHandler({ data: { type: "ready", backend: "wrong-worker" } });
  assert.equal(f.sensor.ready, false);
  replacement.onmessage({ data: { type: "ready", backend: "webgl" } });
  assert.equal(f.sensor.ready, true);
  assert.equal(f.sensor.error, null);
  assert.equal(f.sensor.update(1000), true);
  await Promise.resolve();
  f.sensor.dispose();
});

test("activity history is bounded, freezes on pause, and resets for a new calibration or target", async () => {
  const f = fixture();
  f.sensor.start();
  f.ready();
  for (let i = 0; i < 70; i++) {
    assert.equal(f.sensor.update(i * 500), true);
    await Promise.resolve();
    f.finish(i % 7);
  }
  const history = f.sensor.getHistory();
  assert.equal(history.length, 60);
  assert.equal(history[0].timestamp, 5000);
  assert.equal(history.at(-1).timestamp, 34500);
  assert.equal(history.at(-1).level, f.sensor.getLevel());
  assert.ok(Object.isFrozen(history));
  assert.ok(history.every((sample) => sample.level >= 0 && sample.level <= 1));
  f.sensor.stop();
  assert.equal(f.sensor.getHistory(), history);
  assert.equal(f.sensor.getLevel(), 0);
  f.sensor.start();
  assert.deepEqual(f.sensor.getHistory(), []);
  f.sensor.update(35000);
  await Promise.resolve();
  f.finish(3);
  f.sensor.setTarget("mixed_5b", 120);
  assert.deepEqual(f.sensor.getHistory(), []);
  f.sensor.dispose();
});

test("Inception routes work without audio input, preserve polarity and survive restoration", (context) => {
  const original = inceptionSensor.getLevel;
  inceptionSensor.getLevel = () => 0.8;
  context.after(() => {
    inceptionSensor.getLevel = original;
    restoreAudioMatrix("sensor-test", {});
  });
  const definition = { type: "range", min: -10, max: 10 };
  assert.equal(getModulationLevel("inception", null), 0.8);
  assert.equal(
    applyAudioModulation(
      definition,
      0,
      { source: "inception", depth: 0.5 },
      null,
    ),
    4,
  );
  assert.equal(
    applyAudioModulation(
      definition,
      0,
      { source: "inception", depth: -0.5 },
      null,
    ),
    -4,
  );
  assert.equal(
    applyAudioModulation(
      definition,
      9,
      { source: "inception", depth: 1 },
      null,
    ),
    10,
  );
  setAudioRoute("sensor-test", "angle", { source: "inception", depth: 0.3 });
  const saved = audioMatrixForModel("sensor-test");
  restoreAudioMatrix("sensor-test", saved, ["angle"]);
  assert.deepEqual(getAudioRoute("sensor-test", "angle"), {
    source: "inception",
    depth: 0.3,
  });
  assert.equal(hasModulationSource("sensor-test", "inception"), true);
  assert.equal(hasModulationSource("other-model", "inception"), false);
});

test("the sensor path has no backward pass or synchronous main-thread pixel read", async () => {
  const sources = await Promise.all(
    ["inception-sensor.js", "inception-sensor.worker.js"].map((file) =>
      readFile(
        new URL(
          `../../assets/js/models/neural-growth/${file}`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  for (const source of sources)
    assert.doesNotMatch(
      source,
      /\.(?:valueAndGrad|grads|grad|variableGrads|dataSync|getImageData|readPixels)\s*\(/,
    );
  assert.match(sources[1], /activation\.mean\(\[1, 2\]\)/);
  assert.match(sources[1], /await scalar\.data\(\)/);
});

test("saved runs retain the shared sensor target in storage and CSV export", (context) => {
  const originalWindow = globalThis.window;
  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const record = ExperimentStore.add({
    modelId: "sensor-test",
    inceptionSensorTarget: { layer: "mixed_5b", channel: 120 },
    audioModulation: { rotation: { source: "inception", depth: 0.25 } },
  });
  try {
    assert.deepEqual(ExperimentStore.get(record.id).inceptionSensorTarget, {
      layer: "mixed_5b",
      channel: 120,
    });
    assert.match(ExperimentStore.toCsv(), /inception_sensor_target_json/);
    assert.match(ExperimentStore.toCsv(), /mixed_5b/);
    assert.equal(
      ExperimentStore.get(record.id).audioModulation.rotation.source,
      "inception",
    );
  } finally {
    ExperimentStore.remove(record.id);
  }
});
