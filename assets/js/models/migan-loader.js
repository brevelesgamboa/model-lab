import { ensureOnnxRuntime, onnxRuntimeMode } from "../core/ort-runtime.js";

export const MIGAN_URL = new URL(
  "../../../models/inpainting/migan_pipeline_v2.onnx",
  import.meta.url,
).href;
export const MIGAN_KEY = "migan_pipeline_v2";

// An isolated database: optional user-selected weights never enter app presets.
export async function miganCache(
  action,
  buffer,
  indexedDB = globalThis.indexedDB,
) {
  if (!indexedDB) {
    if (action === "put") throw new Error("IndexedDB is unavailable.");
    return null;
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("latent-field-inpainting", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("model_cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Model cache is busy in another tab."));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
        "model_cache",
        action === "get" ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("model_cache");
      const request =
        action === "get"
          ? store.get(MIGAN_KEY)
          : action === "delete"
            ? store.delete(MIGAN_KEY)
            : store.put(buffer, MIGAN_KEY);
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || request.error || new Error("Model cache failed."));
    });
  } finally {
    db.close();
  }
}

export function validateMiganSession(session) {
  const metadata = session.inputMetadata;
  const get = (name) =>
    Array.isArray(metadata)
      ? metadata.find((m) => m.name === name)
      : metadata?.[name];
  if (
    !session.inputNames?.includes("image") ||
    !session.inputNames?.includes("mask") ||
    !session.outputNames?.includes("result")
  )
    throw new Error(
      "Choose the MI-GAN pipeline v2 model (image, mask → result).",
    );
  for (const [name, channels] of [
    ["image", 3],
    ["mask", 1],
  ]) {
    const m = get(name);
    const dims = m?.shape ?? m?.dimensions;
    if (
      m?.type !== "uint8" ||
      dims?.length !== 4 ||
      (typeof dims[1] === "number" && dims[1] !== channels)
    )
      throw new Error(
        "MI-GAN pipeline v2 requires uint8 NCHW image and mask inputs.",
      );
  }
}

export class MiganLoader {
  constructor({
    runtime = ensureOnnxRuntime,
    mode = onnxRuntimeMode,
    cache = miganCache,
    fetcher = (...args) => fetch(...args),
  } = {}) {
    Object.assign(this, { runtime, mode, cache, fetcher });
    this.session = null;
    this.pending = null;
  }
  async compile(buffer, origin) {
    const ort = await this.runtime();
    let session,
      backend = "WASM";
    if (this.mode() === "webgpu") {
      try {
        session = await ort.InferenceSession.create(buffer, {
          executionProviders: ["webgpu", "wasm"],
        });
        backend = "WebGPU + WASM";
      } catch {
        /* Unsupported graph operators can still run in WASM. */
      }
    }
    session ??= await ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
    });
    try {
      validateMiganSession(session);
    } catch (error) {
      await session.release();
      throw error;
    }
    session.miganInfo = { backend, origin, cached: false };
    const previous = this.session;
    this.session = session;
    if (previous && previous !== session)
      await previous.release().catch(() => {});
    return session;
  }
  get(onPromptFile = () => null) {
    if (this.session) return Promise.resolve(this.session);
    if (this.pending) return this.pending;
    this.pending = this.discover(onPromptFile).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async discover(onPromptFile) {
    const buffer = await this.cache("get").catch(() => null);
    if (buffer instanceof ArrayBuffer) {
      try {
        const session = await this.compile(buffer, "Cached");
        session.miganInfo.cached = true;
        return session;
      } catch {
        await this.cache("delete").catch(() => {});
      }
    }
    const response = await this.fetcher(MIGAN_URL, { method: "HEAD" }).catch(
      () => null,
    );
    if (response?.status === 200) {
      const body = await this.fetcher(MIGAN_URL);
      if (!body.ok)
        throw new Error("The local MI-GAN model could not be read.");
      return this.loadBuffer(await body.arrayBuffer(), "Local file");
    }
    return onPromptFile();
  }
  async loadBuffer(buffer, origin) {
    const session = await this.compile(buffer, origin);
    try {
      await this.cache("put", buffer);
      session.miganInfo.cached = true;
    } catch {
      /* Storage denial must not prevent this session from working. */
    }
    return session;
  }
  async fromFile(file) {
    if (
      !/\.onnx$/i.test(file?.name ?? "") ||
      file.size < 1 ||
      file.size > 100 * 1024 * 1024
    )
      throw new Error("Choose migan_pipeline_v2.onnx (up to 100 MB).");
    return this.loadBuffer(await file.arrayBuffer(), "Selected file");
  }
}
const loader = new MiganLoader();
export const getMiganSession = (onPromptFile) => loader.get(onPromptFile);
export const loadMiganFromFile = (file) => loader.fromFile(file);
