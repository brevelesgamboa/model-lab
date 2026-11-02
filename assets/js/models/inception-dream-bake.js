import { validateFeatureTarget } from "./inception-feature-map.js";

const cancelled = () => new DOMException("Dream bake cancelled.", "AbortError");
export class DomeDreamBaker {
  constructor({
    createWorker = () =>
      new Worker(new URL("./inception-dream-bake.worker.js", import.meta.url)),
    capture = (image) => createImageBitmap(image),
    persistent = false,
  } = {}) {
    this.createWorker = createWorker;
    this.capture = capture;
    this.pending = null;
    this.runs = 0;
    this.persistent = persistent;
    this.worker = null;
  }
  bake(
    canvas,
    layer,
    channel,
    iterations = 15,
    {
      signal,
      onProgress = () => {},
      photoRect = canvas.photoRect,
      colorRetention = 1,
      stepSize = 0.04,
      preserveDetail = false,
    } = {},
  ) {
    const target = validateFeatureTarget(layer, channel);
    if (!Number.isFinite(stepSize) || stepSize < 0 || stepSize > 0.04)
      throw new RangeError("Invalid dream step size.");
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100)
      throw new RangeError("Invalid dream iteration count.");
    if (
      !Number.isFinite(colorRetention) ||
      colorRetention < 0 ||
      colorRetention > 1
    )
      throw new RangeError("Invalid color retention.");
    if (this.pending) this.cancel();
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
        if (error || !this.persistent) {
          request.worker?.terminate();
          if (this.worker === request.worker) this.worker = null;
        }
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
            const worker = this.worker ?? this.createWorker();
            this.worker = worker;
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
                colorRetention,
                stepSize,
                preserveDetail,
                keepAlive: this.persistent,
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
    this.worker?.terminate();
    this.worker = null;
  }
  dispose() {
    this.cancel();
  }
}

export function uploadDream360(gl, texture, image) {
  const { width, height } = image;
  let ctx = image.getContext?.("2d");
  if (!ctx) {
    // Keep non-2D image sources on the same byte upload path too.
    const canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, width, height);
  }
  // ImageData exposes canonical RGBA bytes, bypassing canvas GPU surface
  // imports whose BGRA channel order can be mishandled by some drivers.
  const { data } = ctx.getImageData(0, 0, width, height);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
}

export async function bakeFullDome360(
  gl,
  equirectCanvas,
  layerName,
  channelIndex,
  iterations = 15,
  onProgress = () => {},
  { baker = new DomeDreamBaker(), texture, signal, colorRetention = 1 } = {},
) {
  const result = await baker.bake(
    equirectCanvas,
    layerName,
    channelIndex,
    iterations,
    { signal, onProgress, colorRetention },
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
