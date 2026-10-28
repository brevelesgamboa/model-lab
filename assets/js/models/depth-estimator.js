import { blurredLuminance } from "./depth-data.js";

const abortError = () =>
  new DOMException("Depth estimation cancelled.", "AbortError");

export class DepthEstimator {
  constructor({
    createWorker = () =>
      new Worker(new URL("./depth-estimator.worker.js", import.meta.url), {
        type: "module",
      }),
    capture = (image) => createImageBitmap(image),
  } = {}) {
    this.createWorker = createWorker;
    this.capture = capture;
    this.pending = null;
    this.runs = 0;
  }
  estimate(image, { signal, onStatus = () => {} } = {}) {
    this.cancel();
    if (signal?.aborted) return Promise.reject(abortError());
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
      request.abort = () => finish(abortError());
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
              else if (data.type === "result") finish(null, data);
              else if (data.type === "error") finish(new Error(data.error));
            };
            worker.onerror = (event) =>
              finish(new Error(event.message || "The depth worker failed."));
            worker.onmessageerror = () =>
              finish(new Error("The depth result could not be read."));
            this.runs++;
            worker.postMessage({ bitmap }, [bitmap]);
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

export function luminanceDepth(image) {
  const sourceWidth = image.naturalWidth || image.width,
    sourceHeight = image.naturalHeight || image.height;
  if (!(sourceWidth && sourceHeight)) throw new Error("The photo is empty.");
  const scale = Math.min(1, 256 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale)),
    height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return {
    width,
    height,
    depth: blurredLuminance(
      ctx.getImageData(0, 0, width, height).data,
      width,
      height,
    ),
    kind: "luminance",
  };
}

export function uploadDepthTexture(gl, texture, { depth, width, height }) {
  if (!(depth instanceof Float32Array) || depth.length !== width * height)
    throw new Error("The depth texture dimensions are invalid.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R16F,
    width,
    height,
    0,
    gl.RED,
    gl.FLOAT,
    depth,
  );
}

// The caller owns the returned/provided texture. The preview is uploaded before
// the first await, and remains usable if downloading or inference fails.
export async function computeDepthTexture(
  gl,
  image,
  {
    texture = gl.createTexture(),
    estimator = new DepthEstimator(),
    signal,
    fallback = luminanceDepth(image),
    onFallback = () => {},
    onStatus,
  } = {},
) {
  uploadDepthTexture(gl, texture, fallback);
  onFallback({ ...fallback, texture });
  try {
    const result = await estimator.estimate(image, { signal, onStatus });
    if (signal?.aborted) throw abortError();
    uploadDepthTexture(gl, texture, result);
    return { ...result, texture, kind: "estimated" };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { ...fallback, texture, error: error.message };
  }
}
