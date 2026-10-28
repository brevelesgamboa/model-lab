import {
  INCEPTION_LAYERS,
  getInceptionLayerChannels,
} from "./inception-layers.js";

export const INCEPTION_SENSOR_INTERVAL_MS = 500;
export const INCEPTION_SENSOR_IMAGE_SIZE = 128;
export const INCEPTION_SENSOR_DEFAULT_TARGET = Object.freeze({
  layer: "Conv2d_4a_3x3",
  channel: 42,
});

// ImageBitmap snapshots avoid synchronous readPixels/getImageData on the UI
// thread. The worker imports pixels into WebGL and reads only a pooled scalar.
export class InceptionSensor {
  constructor({
    getCanvas = () => null,
    createWorker = () =>
      new Worker(new URL("./inception-sensor.worker.js", import.meta.url)),
    capture = (canvas) =>
      globalThis.createImageBitmap(canvas, {
        resizeWidth: INCEPTION_SENSOR_IMAGE_SIZE,
        resizeHeight: INCEPTION_SENSOR_IMAGE_SIZE,
        resizeQuality: "low",
      }),
  } = {}) {
    this.getCanvas = getCanvas;
    this.createWorker = createWorker;
    this.capture = capture;
    this.target = { ...INCEPTION_SENSOR_DEFAULT_TARGET };
    this.active = false;
    this.status = "idle";
    this.worker = null;
    this.ready = false;
    this.pending = null;
    this.generation = 0;
    this.requestId = 0;
    this.lastRun = -Infinity;
    this.sourceKey = null;
    this.inferenceCount = 0;
    this.error = null;
    this.resetSignal();
  }

  resetSignal({ clearHistory = true } = {}) {
    this.generation++;
    this.level = 0;
    this.raw = null;
    this.low = null;
    this.high = null;
    this.samples = 0;
    if (clearHistory) this.history = Object.freeze([]);
  }

  setSourceKey(key) {
    if (key === this.sourceKey) return;
    this.sourceKey = key;
    this.resetSignal();
  }

  setTarget(layer, channel) {
    if (!Object.hasOwn(INCEPTION_LAYERS, layer))
      throw new RangeError("Unknown Inception sensor layer.");
    if (!Number.isFinite(Number(channel)))
      throw new RangeError("The sensor channel must be a number.");
    const selected = Math.max(
      0,
      Math.min(
        getInceptionLayerChannels(layer) - 1,
        Math.round(Number(channel)),
      ),
    );
    if (layer === this.target.layer && selected === this.target.channel) return;
    this.target = { layer, channel: selected };
    this.resetSignal();
  }

  getTarget() {
    return { ...this.target };
  }
  getLevel() {
    return this.active && !this.error ? this.level : 0;
  }
  getHistory() {
    return this.history;
  }
  getStats() {
    return {
      active: this.active,
      status: this.status,
      inFlight: Boolean(this.pending),
      level: this.getLevel(),
      raw: this.raw,
      samples: this.samples,
      inferenceCount: this.inferenceCount,
      lastRun: this.lastRun,
      inferenceMs: this.inferenceMs ?? null,
      captureMs: this.captureMs ?? null,
      backend: this.backend ?? null,
      loadMs: this.loadMs ?? null,
      downloadedValues: this.downloadedValues ?? null,
      retainedTensors: this.retainedTensors ?? null,
      imageSize: INCEPTION_SENSOR_IMAGE_SIZE,
      error: this.error,
      ...this.target,
    };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.error = null;
    this.resetSignal();
    this.status = this.ready ? "calibrating" : "loading";
    if (this.worker) return;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = (event) => {
        if (this.worker === worker) this.onMessage(event.data);
      };
      worker.onerror = (event) => {
        if (this.worker === worker)
          this.fail(event.message || "The visual sensor worker failed.");
      };
      worker.onmessageerror = () => {
        if (this.worker === worker)
          this.fail("The visual sensor response could not be read.");
      };
      worker.postMessage({
        type: "init",
        runtimeUrl: new URL(
          "../../../vendor/tensorflow/tf.min.js",
          import.meta.url,
        ).href,
        modelUrl: new URL(
          "../../../../models/inception/model.json",
          import.meta.url,
        ).href,
        node: INCEPTION_LAYERS[this.target.layer],
        size: INCEPTION_SENSOR_IMAGE_SIZE,
      });
    } catch (error) {
      this.fail(error.message);
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.error = null;
    this.resetSignal({ clearHistory: false });
    this.status = "idle";
    // Keep the loaded worker/model reusable. A pending response is invalidated
    // but retains its busy guard until completion, including across restart.
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.pending = null;
  }

  fail(message) {
    this.resetSignal();
    this.error = message;
    this.status = "error";
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.pending = null;
  }

  update(timestamp) {
    if (
      !this.active ||
      !this.ready ||
      this.error ||
      this.pending ||
      !Number.isFinite(timestamp) ||
      timestamp - this.lastRun < INCEPTION_SENSOR_INTERVAL_MS
    )
      return false;
    const canvas = this.getCanvas();
    if (!canvas?.width || !canvas?.height) return false;
    this.lastRun = timestamp;
    const request = {
      id: ++this.requestId,
      generation: this.generation,
      timestamp,
      ...this.target,
    };
    this.pending = request;
    this.captureAndSend(canvas, request);
    return true;
  }

  async captureAndSend(canvas, request) {
    let bitmap;
    const started = performance.now();
    try {
      bitmap = await this.capture(canvas);
      if (
        !this.active ||
        request.generation !== this.generation ||
        this.pending !== request
      )
        return;
      this.captureMs = performance.now() - started;
      this.worker.postMessage(
        {
          type: "observe",
          id: request.id,
          bitmap,
          node: INCEPTION_LAYERS[request.layer],
          channel: request.channel,
        },
        [bitmap],
      );
      bitmap = null; // Ownership transferred to the worker.
      this.status = "observing";
    } catch (error) {
      if (request.generation === this.generation && this.pending === request)
        this.fail(error.message);
    } finally {
      if (bitmap) bitmap.close();
      if (request.generation !== this.generation && this.pending === request)
        this.pending = null;
    }
  }

  onMessage(message) {
    if (message.type === "ready") {
      this.ready = true;
      this.backend = message.backend;
      this.loadMs = message.loadMs;
      this.status = this.active ? "calibrating" : "idle";
      return;
    }
    const request = this.pending;
    if (message.type === "error") {
      if (message.id && (!request || message.id !== request.id)) return;
      if (message.id && request.generation !== this.generation) {
        this.pending = null;
        return;
      }
      this.fail(message.error);
      return;
    }
    if (message.type !== "sample" || !request || message.id !== request.id)
      return;
    this.pending = null;
    if (!this.active || request.generation !== this.generation) return;
    if (!Number.isFinite(message.raw)) {
      this.fail("The feature activation is not finite.");
      return;
    }
    this.inferenceCount++;
    this.raw = message.raw;
    if (this.low === null) this.low = this.high = message.raw;
    this.low = Math.min(
      message.raw,
      this.low + 0.01 * (message.raw - this.low),
    );
    this.high = Math.max(
      message.raw,
      this.high + 0.01 * (message.raw - this.high),
    );
    const span = Math.max(
      this.high - this.low,
      0.01 * Math.max(1, Math.abs(message.raw)),
    );
    const normalized = Math.max(
      0,
      Math.min(1, (message.raw - this.low) / span),
    );
    this.level += (normalized - this.level) * 0.15;
    this.samples++;
    // Share one bounded, immutable history between all route drawers. Recording
    // an accepted scalar adds no inference or GPU readback work.
    this.history = Object.freeze([
      ...this.history.slice(-59),
      Object.freeze({ timestamp: request.timestamp, level: this.level }),
    ]);
    this.inferenceMs = message.inferenceMs;
    this.downloadedValues = message.downloadedValues;
    this.retainedTensors = message.retainedTensors;
    this.status = "observing";
  }
}

export const inceptionSensor = new InceptionSensor();
