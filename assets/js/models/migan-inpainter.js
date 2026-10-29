import { create360Canvas } from "./equirectangular-canvas.js";
import { ensureOnnxRuntime } from "../core/ort-runtime.js";

// Official pipeline v2 performs normalization/resizing internally. White keeps
// the photo; black requests synthesis. See Picsart-AI-Research/MI-GAN.
export function packMiganInputs(rgba, width, height, rect) {
  const count = width * height,
    image = new Uint8Array(count * 3),
    mask = new Uint8Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (let c = 0; c < 3; c++) image[c * count + i] = rgba[i * 4 + c];
      if (
        x >= rect.x &&
        x < rect.x + rect.width &&
        y >= rect.y &&
        y < rect.y + rect.height
      )
        mask[i] = 255;
    }
  return { image, mask };
}

export function compositeMigan(result, source, width, height, rect) {
  const output = new Uint8ClampedArray(width * height * 4),
    count = width * height;
  const cosine = (d) =>
    0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, (d + 10) / 20)));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const distance = Math.min(
        x - rect.x,
        rect.x + rect.width - 1 - x,
        y - rect.y,
        rect.y + rect.height - 1 - y,
      );
      const keep = cosine(distance);
      for (let c = 0; c < 3; c++)
        output[i * 4 + c] =
          result[c * count + i] * (1 - keep) + source[i * 4 + c] * keep;
      output[i * 4 + 3] = 255;
    }
  // Couple a small rear band on the circle and converge both pole rows.
  // MI-GAN was trained on flat photographs; it has no spherical boundary rule.
  const original = output.slice(),
    band = Math.min(20, Math.floor(width / 4));
  for (let y = 0; y < height; y++)
    for (let d = 0; d < band; d++) {
      const a = (y * width + d) * 4,
        b = (y * width + width - 1 - d) * 4;
      const blend = 0.5 * (1 + Math.cos((Math.PI * d) / band));
      for (let c = 0; c < 3; c++) {
        const mean = (original[a + c] + original[b + c]) / 2;
        output[a + c] = original[a + c] * (1 - blend) + mean * blend;
        output[b + c] = original[b + c] * (1 - blend) + mean * blend;
      }
    }
  for (const top of [true, false])
    for (let d = 0; d < 12; d++) {
      const y = top ? d : height - 1 - d;
      if (y < 0 || y >= height) continue;
      const mean = [0, 0, 0];
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++)
          mean[c] += output[(y * width + x) * 4 + c] / width;
      const blend = 0.5 * (1 + Math.cos((Math.PI * d) / 12));
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++)
          output[(y * width + x) * 4 + c] =
            output[(y * width + x) * 4 + c] * (1 - blend) + mean[c] * blend;
    }
  return output;
}

export async function inpaintEquirectangular(
  sourceCanvas,
  session,
  { coverage = "immersive" } = {},
) {
  const canvas = create360Canvas(sourceCanvas, 1024, 512, { coverage }),
    { width, height, photoRect } = canvas;
  const ctx = canvas.getContext("2d");
  // Feed the unmodified photo to the known-region mask. The border-smear
  // initializer has its own 50px feather; composition here uses 20px instead.
  ctx.drawImage(
    sourceCanvas,
    photoRect.x,
    photoRect.y,
    photoRect.width,
    photoRect.height,
  );
  const source = ctx.getImageData(0, 0, width, height).data;
  const packed = packMiganInputs(source, width, height, photoRect),
    ort = await ensureOnnxRuntime();
  const image = new ort.Tensor("uint8", packed.image, [1, 3, height, width]);
  const mask = new ort.Tensor("uint8", packed.mask, [1, 1, height, width]);
  let outputs;
  try {
    outputs = await session.run({ image, mask });
    const result = outputs.result;
    if (
      result?.type !== "uint8" ||
      result.dims.join() !== [1, 3, height, width].join()
    )
      throw new Error("Unexpected MI-GAN output. Use pipeline v2.");
    ctx.putImageData(
      new ImageData(
        compositeMigan(
          await result.getData(),
          source,
          width,
          height,
          photoRect,
        ),
        width,
        height,
      ),
      0,
      0,
    );
    return canvas;
  } finally {
    image.dispose();
    mask.dispose();
    for (const tensor of Object.values(outputs ?? {})) tensor.dispose();
  }
}

// The compiled session lives in this persistent worker. Cancelling terminates
// expensive compilation/inference and makes all old results unreachable.
export class MiganInpainter {
  constructor({
    createWorker = () =>
      new Worker(new URL("./migan-inpainter.worker.js", import.meta.url), {
        type: "module",
      }),
    capture = (source) => createImageBitmap(source),
  } = {}) {
    this.createWorker = createWorker;
    this.capture = capture;
    this.worker = null;
    this.pending = null;
    this.epoch = 0;
  }
  request(type, payload = {}, transfers = []) {
    if (this.pending)
      return Promise.reject(new Error("MI-GAN is already working."));
    this.worker ??= this.createWorker();
    return new Promise((resolve, reject) => {
      const request = { reject };
      this.pending = request;
      const finish = (error, value) => {
        if (this.pending !== request) return;
        this.pending = null;
        if (error) reject(error);
        else resolve(value);
      };
      this.worker.onmessage = ({ data }) =>
        data.type === "error"
          ? finish(new Error(data.error))
          : finish(null, data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        if (this.pending !== request) return;
        finish(new Error(e.message || "MI-GAN could not start."));
        this.cancel();
      };
      this.worker.onmessageerror = () => {
        if (this.pending !== request) return;
        finish(new Error("MI-GAN returned an unreadable result."));
        this.cancel();
      };
      try {
        this.worker.postMessage({ type, ...payload }, transfers);
      } catch (error) {
        finish(error);
        this.cancel();
      }
    });
  }
  prepare(file) {
    return this.request("prepare", { file });
  }
  async inpaint(source, { coverage = "immersive" } = {}) {
    const epoch = this.epoch,
      bitmap = await this.capture(source);
    if (epoch !== this.epoch) {
      bitmap.close();
      throw new DOMException("Inpainting cancelled.", "AbortError");
    }
    try {
      const result = await this.request(
        "inpaint",
        { bitmap, coverage },
        [bitmap],
      );
      const canvas = new OffscreenCanvas(result.width, result.height);
      canvas
        .getContext("2d")
        .putImageData(
          new ImageData(result.rgba, result.width, result.height),
          0,
          0,
        );
      canvas.photoRect = result.photoRect;
      return canvas;
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }
  cancel() {
    this.epoch++;
    this.worker?.terminate();
    this.worker = null;
    this.pending?.reject(
      new DOMException("Inpainting cancelled.", "AbortError"),
    );
    this.pending = null;
  }
}
