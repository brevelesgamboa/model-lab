import { validateFeatureTarget } from "./inception-feature-map.js";

const cancelled = () => new DOMException("Dream bake cancelled.", "AbortError");
export class DomeDreamBaker {
  constructor({
    createWorker = () =>
      new Worker(new URL("./inception-dream-bake.worker.js", import.meta.url)),
    capture = (image) => createImageBitmap(image),
  } = {}) {
    this.createWorker = createWorker;
    this.capture = capture;
    this.pending = null;
    this.runs = 0;
  }
  bake(
    canvas,
    layer,
    channel,
    iterations = 15,
    { signal, onProgress = () => {}, photoRect = canvas.photoRect } = {},
  ) {
    const target = validateFeatureTarget(layer, channel);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100)
      throw new RangeError("Invalid dream iteration count.");
    if (!photoRect) throw new Error("The panorama has no photo placement.");
    this.cancel();
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const request = { worker: null };
      const finish = (error, result) => {
        if (this.pending !== request) {
          result?.bitmap?.close();
          return;
        }
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
        .then(() => this.capture(canvas))
        .then((bitmap) => {
          if (this.pending !== request) {
            bitmap.close();
            return;
          }
          try {
            const worker = this.createWorker();
            request.worker = worker;
            worker.onmessage = ({ data }) => {
              if (this.pending !== request) {
                data.bitmap?.close();
                return;
              }
              if (data.type === "progress")
                onProgress(data.percent, data.message);
              else if (data.type === "result") finish(null, data);
              else if (data.type === "error") finish(new Error(data.error));
            };
            worker.onerror = (e) =>
              finish(new Error(e.message || "Dream worker failed."));
            worker.onmessageerror = () =>
              finish(new Error("The dream result could not be read."));
            this.runs++;
            worker.postMessage(
              {
                bitmap,
                ...target,
                iterations,
                photoRect,
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

export function uploadDream360(gl, texture, image) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
}

export async function bakeFullDome360(
  gl,
  equirectCanvas,
  layerName,
  channelIndex,
  iterations = 15,
  onProgress = () => {},
  { baker = new DomeDreamBaker(), texture, signal } = {},
) {
  const result = await baker.bake(
    equirectCanvas,
    layerName,
    channelIndex,
    iterations,
    { signal, onProgress },
  );
  try {
    if (signal?.aborted) throw cancelled();
    texture ??= gl.createTexture();
    const canvas = new OffscreenCanvas(result.width, result.height);
    canvas
      .getContext("2d")
      .putImageData(
        new ImageData(result.rgba, result.width, result.height),
        0,
        0,
      );
    uploadDream360(gl, texture, canvas);
    const { rgba: _rgba, ...stats } = result;
    return { ...stats, canvas, texture };
  } catch (error) {
    result.bitmap?.close();
    throw error;
  }
}
