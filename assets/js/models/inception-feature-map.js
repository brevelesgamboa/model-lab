import {
  INCEPTION_LAYERS,
  getInceptionLayerChannels,
} from "./neural-growth/inception-layers.js";
import { uploadDepthTexture } from "./depth-estimator.js";

export const FEATURE_TARGETS = Object.freeze([
  { layer: "mixed_5b", channel: 120 },
  { layer: "mixed_6a", channel: 42 },
  { layer: "Conv2d_4a_3x3", channel: 42 },
  { layer: "mixed_6d", channel: 182 },
  { layer: "mixed_7b", channel: 314 },
]);

export function validateFeatureTarget(layer, channel) {
  if (!Object.hasOwn(INCEPTION_LAYERS, layer))
    throw new RangeError("Unknown Inception layer.");
  if (
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel >= getInceptionLayerChannels(layer)
  )
    throw new RangeError("The Inception channel is out of bounds.");
  return { layer, channel, node: INCEPTION_LAYERS[layer] };
}

const cancelled = () =>
  new DOMException("Feature mapping cancelled.", "AbortError");
export const emptyFeatureMap = () => ({
  width: 1,
  height: 1,
  values: new Float32Array(1),
  kind: "empty",
});

// A spatial map intentionally downloads one small channel, unlike the scalar
// sensor. One worker/run per request; camera and wave changes never call it.
export class FeatureHeatmapEstimator {
  constructor({
    createWorker = () =>
      new Worker(new URL("./inception-feature-map.worker.js", import.meta.url)),
    capture = (image) =>
      createImageBitmap(image, {
        resizeWidth: 299,
        resizeHeight: 299,
        resizeQuality: "high",
      }),
  } = {}) {
    this.createWorker = createWorker;
    this.capture = capture;
    this.pending = null;
    this.runs = 0;
  }
  estimate(image, layer, channel, { signal, onStatus = () => {} } = {}) {
    const target = validateFeatureTarget(layer, channel);
    this.cancel();
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const request = { worker: null };
      const finish = (error, result) => {
        if (this.pending !== request) return;
        this.pending = null;
        signal?.removeEventListener("abort", request.abort);
        request.worker?.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      request.abort = () => finish(cancelled());
      this.pending = request;
      signal?.addEventListener("abort", request.abort, { once: true });
      Promise.resolve()
        .then(() => this.capture(image))
        .then((bitmap) => {
          if (this.pending !== request) {
            bitmap.close();
            return;
          }
          try {
            const worker = this.createWorker();
            request.worker = worker;
            worker.onmessage = ({ data }) => {
              if (this.pending !== request) return;
              if (data.type === "status") onStatus(data.message);
              else if (data.type === "result")
                finish(null, { ...data, ...target, kind: "activation" });
              else if (data.type === "error") finish(new Error(data.error));
            };
            worker.onerror = (e) =>
              finish(new Error(e.message || "The feature worker failed."));
            worker.onmessageerror = () =>
              finish(new Error("The feature map could not be read."));
            this.runs++;
            worker.postMessage(
              {
                bitmap,
                ...target,
                runtimeUrl: new URL(
                  "../../vendor/tensorflow/tf.min.js",
                  import.meta.url,
                ).href,
                modelUrl: new URL(
                  "../../../models/inception/model.json",
                  import.meta.url,
                ).href,
              },
              [bitmap],
            );
          } catch (error) {
            bitmap.close();
            finish(error);
          }
        })
        .catch((error) => finish(error));
    });
  }
  cancel() {
    this.pending?.abort();
  }
  dispose() {
    this.cancel();
  }
}

export function uploadFeatureTexture(gl, texture, map) {
  uploadDepthTexture(gl, texture, { ...map, depth: map.values });
}

export async function computeFeatureHeatmap(
  gl,
  imageElement,
  layerName = "mixed_5b",
  channelIndex = 120,
  {
    texture = gl.createTexture(),
    estimator = new FeatureHeatmapEstimator(),
    signal,
    onStatus,
  } = {},
) {
  validateFeatureTarget(layerName, channelIndex);
  const fallback = emptyFeatureMap();
  uploadFeatureTexture(gl, texture, fallback);
  try {
    const result = await estimator.estimate(
      imageElement,
      layerName,
      channelIndex,
      {
        signal,
        onStatus,
      },
    );
    if (signal?.aborted) throw cancelled();
    uploadFeatureTexture(gl, texture, result);
    return { ...result, texture };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { ...fallback, texture, error: error.message };
  }
}
