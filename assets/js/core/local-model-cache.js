import { DEPTH_MODEL_ROOT } from "../models/depth-data.js";

// Version the graph cache when the bundled checkpoint changes. Depth URLs are
// pinned to a repository revision. No uploaded photos enter this cache.
export const MODEL_CACHE_NAME = "latent-field-models-10256b8f-c3b67641-v1";
export const INCEPTION_MODEL_URL = new URL(
  "../../../models/inception/model.json",
  import.meta.url,
).href;
export const DEPTH_MODEL_URLS = ["model_q4.onnx", "model_q4.onnx_data"].map(
  (name) => DEPTH_MODEL_ROOT + name,
);

export async function cachedModelFetch(
  input,
  init,
  { storage = globalThis.caches, fetcher = globalThis.fetch } = {},
) {
  const request = new Request(input, init);
  if (request.signal.aborted)
    throw new DOMException("Model download cancelled.", "AbortError");
  let cache;
  try {
    cache = await storage?.open(MODEL_CACHE_NAME);
    const saved = await cache?.match(request);
    if (saved?.ok) return saved;
  } catch {
    /* Storage can be unavailable or full; online inference still works. */
  }
  const response = await fetcher(request);
  if (response.ok && request.method === "GET" && cache) {
    try {
      await cache.put(request, response.clone());
    } catch {
      /* Reported as missing by inspection. */
    }
  }
  return response;
}

function inceptionUrls(manifest) {
  const paths = manifest.weightsManifest?.flatMap((group) => group.paths) || [];
  if (!paths.length) throw new Error("The Inception manifest has no weights.");
  return [
    ...new Set(paths.map((path) => new URL(path, INCEPTION_MODEL_URL).href)),
  ];
}

export async function inspectModelCache({ storage = globalThis.caches } = {}) {
  try {
    if (!storage) throw new Error("Cache Storage is unavailable.");
    const cache = await storage.open(MODEL_CACHE_NAME);
    const graph = await cache.match(INCEPTION_MODEL_URL);
    const urls = graph?.ok
      ? [INCEPTION_MODEL_URL, ...inceptionUrls(await graph.json())]
      : [INCEPTION_MODEL_URL];
    const count = async (paths) => {
      const matches = await Promise.all(
        paths.map(async (path) => Boolean((await cache.match(path))?.ok)),
      );
      return matches.filter(Boolean).length;
    };
    const [inceptionCount, depthCount] = await Promise.all([
      count(urls),
      count(DEPTH_MODEL_URLS),
    ]);
    return {
      available: true,
      inception: {
        ready: Boolean(graph?.ok) && inceptionCount === urls.length,
        count: inceptionCount,
        total: graph?.ok ? urls.length : null,
      },
      depth: {
        ready: depthCount === DEPTH_MODEL_URLS.length,
        count: depthCount,
        total: DEPTH_MODEL_URLS.length,
      },
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

export async function cacheLocalModels({ onProgress = () => {}, signal } = {}) {
  if (!globalThis.caches)
    throw new Error("Local model caching is unavailable.");
  const graph = await cachedModelFetch(INCEPTION_MODEL_URL, { signal });
  if (!graph.ok)
    throw new Error(`Inception download failed (${graph.status}).`);
  const urls = [...inceptionUrls(await graph.json()), ...DEPTH_MODEL_URLS];
  for (let i = 0; i < urls.length; i++) {
    const response = await cachedModelFetch(urls[i], { signal });
    if (!response.ok)
      throw new Error(`Model download failed (${response.status}).`);
    onProgress(Math.round(((i + 1) / urls.length) * 100));
  }
  return inspectModelCache();
}
