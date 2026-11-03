import { WORLD_VERSION, worldArea } from "./dream-world-map.mjs";
import { DomeDreamBaker } from "../assets/js/models/inception-dream-bake.js";
import { ORIGIN_STUDIES } from "./dream-origin-space.mjs";

const cancelled = () =>
  new DOMException("Place preparation cancelled.", "AbortError");
export const copyWorldImage = (image) => {
  const c = document.createElement("canvas");
  c.width = image.naturalWidth || image.width;
  c.height = image.naturalHeight || image.height;
  c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
  return c;
};
export const imageFingerprint = async (image) => {
  const c = copyWorldImage(image),
    pixels = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
};
export function loadWorldImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the local image."));
    image.src = src;
  });
}
export class DreamWorldContent {
  constructor({ stages, key, store, seed = 417, onProgress = () => {} }) {
    this.stages = stages;
    this.key = key;
    this.store = store;
    this.seed = seed;
    this.onProgress = onProgress;
    this.baker = new DomeDreamBaker({ persistent: true });
    this.images = new Map();
    this.metrics = new Map();
    this.runs = 0;
    this.restored = 0;
  }
  async runBake(image, pass, id, signal) {
    const result = await this.baker.bake(
      image,
      pass.layer,
      pass.channel,
      pass.iterations,
      {
        signal,
        photoRect: null,
        colorRetention: 1,
        stepSize: pass.stepSize,
        preserveDetail: true,
        onProgress: (percent) =>
          this.onProgress(id, `Generating ${Math.round(percent)}%`),
      },
    );
    if (signal?.aborted) throw cancelled();
    const canvas = document.createElement("canvas");
    canvas.width = result.width;
    canvas.height = result.height;
    canvas
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(result.rgba),
          result.width,
          result.height,
        ),
        0,
        0,
      );
    this.runs++;
    return {
      canvas,
      metadata: {
        id,
        kind: "generated place",
        ...pass,
        bakeMs: result.bakeMs,
        scoreStart: result.scoreStart,
        scoreEnd: result.scoreEnd,
        retainedTensors: result.retainedTensors,
      },
    };
  }
  async study(index, signal) {
    if (this.stages[index]) return this.stages[index];
    let input = await this.study(index - 1, signal);
    for (const pass of ORIGIN_STUDIES[index].passes) {
      const result = await this.runBake(input, pass, "study", signal);
      input = result.canvas;
    }
    this.stages[index] = input;
    return input;
  }
  async prepare(id, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    if (this.images.has(id)) return this.images.get(id);
    const area = worldArea(id),
      key = `${WORLD_VERSION}:${this.key}:${id}`,
      cached = await this.store.get(key);
    if (signal?.aborted) throw cancelled();
    if (cached) {
      const bitmap = await createImageBitmap(cached.blob);
      if (signal?.aborted) {
        bitmap.close();
        throw cancelled();
      }
      const image = copyWorldImage(bitmap);
      bitmap.close();
      this.images.set(id, image);
      this.metrics.set(id, cached.metadata);
      this.restored++;
      return image;
    }
    let image = await this.study(area.study, signal),
      metadata = { id, kind: "saved model stage", study: area.study };
    if (area.pass) {
      const pass = {
        ...area.pass,
        channel: area.pass.channel + (this.seed % 3),
      };
      this.onProgress(id, "Preparing the next place");
      const result = await this.runBake(image, pass, id, signal);
      image = result.canvas;
      metadata = result.metadata;
    }
    const canvas = copyWorldImage(image),
      blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Could not save the place.")),
          "image/png",
        ),
      );
    if (signal?.aborted) throw cancelled();
    await this.store.put(key, blob, metadata);
    if (signal?.aborted) throw cancelled();
    this.images.set(id, canvas);
    this.metrics.set(id, metadata);
    return canvas;
  }
  dispose() {
    this.baker.dispose();
    this.images.clear();
  }
}
