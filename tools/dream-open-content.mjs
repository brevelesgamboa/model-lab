import {
  DreamWorldContent,
  copyWorldImage,
  loadWorldImage,
} from "./dream-world-content.mjs";
import { WorldImageStore } from "./dream-world-storage.mjs";

// One worker, one pending target and eight resident images regardless of travel.
// Generation is a background task. The viewer always keeps a ready panorama.
export class OpenDriftContent {
  constructor({ stages, fingerprint, landscapes = [], onProgress = () => {} }) {
    this.store = new WorldImageStore();
    this.worker = new DreamWorldContent({
      stages,
      key: fingerprint,
      store: this.store,
      onProgress,
    });
    this.stages = stages;
    this.landscapes = landscapes;
    this.fingerprint = fingerprint;
    this.cache = new Map();
    this.metrics = [];
    this.active = null;
    this.pending = null;
    this.disposed = false;
    this.runs = 0;
    this.error = "";
    this.failure = null;
  }
  async prepare(descriptor, signal) {
    const key = `open-drift-v1:${this.fingerprint}:${descriptor.key}`;
    const entry = await this.store.get(key);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (entry) {
      const bitmap = await createImageBitmap(entry.blob),
        image = copyWorldImage(bitmap);
      bitmap.close();
      return { image, descriptor, restored: true };
    }
    let image;
    if (descriptor.landscape >= 0 && this.landscapes[descriptor.landscape])
      image = this.landscapes[descriptor.landscape];
    else image = await this.worker.study(descriptor.stage, signal);
    if (descriptor.stage > 0) {
      const result = await this.worker.runBake(
        image,
        descriptor,
        descriptor.key,
        signal,
      );
      image = result.canvas;
      this.runs++;
      this.metrics.push(result.metadata);
      if (this.metrics.length > 16) this.metrics.shift();
    }
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const blob = await new Promise((resolve, reject) =>
      image.toBlob
        ? image.toBlob(
            (b) =>
              b ? resolve(b) : reject(new Error("Could not save panorama")),
            "image/png",
          )
        : copyWorldImage(image).toBlob(resolve, "image/png"),
    );
    await this.store.put(key, blob, { descriptor });
    return { image, descriptor, restored: false };
  }
  request(descriptor) {
    if (this.disposed) return;
    if (this.failure?.key === descriptor.key && Date.now() < this.failure.until)
      return null;
    if (this.cache.has(descriptor.key)) {
      const ready = this.cache.get(descriptor.key);
      this.cache.delete(descriptor.key);
      this.cache.set(descriptor.key, ready);
      return ready;
    }
    if (this.active?.descriptor.key !== descriptor.key)
      this.pending = descriptor;
    void this.pump();
    return null;
  }
  async pump() {
    if (this.disposed || this.active || !this.pending) return;
    const descriptor = this.pending,
      abort = new AbortController();
    this.pending = null;
    this.active = { descriptor, abort };
    try {
      const ready = await this.prepare(descriptor, abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      this.cache.set(descriptor.key, ready);
      while (this.cache.size > 8)
        this.cache.delete(this.cache.keys().next().value);
      this.error = "";
      this.failure = null;
    } catch (error) {
      if (error.name !== "AbortError") {
        this.error = error.message;
        this.failure = { key: descriptor.key, until: Date.now() + 5000 };
      }
    } finally {
      this.active = null;
      if (!this.disposed) void this.pump();
    }
  }
  async loadLandscapes() {
    const images = await Promise.all(
      ["valley", "wetland", "folded"].map((id) =>
        loadWorldImage(`/drift/landscapes/${id}.png`),
      ),
    );
    // Match the existing dome bake size. Large arbitrary source dimensions can
    // exceed the local Inception backend's convolution shader limits.
    this.landscapes = images.map((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      canvas.getContext("2d").drawImage(image, 0, 0, 1024, 512);
      return canvas;
    });
    return this.landscapes;
  }
  dispose() {
    this.disposed = true;
    this.pending = null;
    this.active?.abort.abort();
    this.worker.dispose();
    this.cache.clear();
    void this.store.close();
  }
}
