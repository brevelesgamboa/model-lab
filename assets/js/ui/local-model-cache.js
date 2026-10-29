import {
  cacheLocalModels,
  inspectModelCache,
} from "../core/local-model-cache.js";

export function createLocalModelCacheControls(elements) {
  let busy = false,
    refreshId = 0;
  const describe = (name, state) =>
    `${name}: ${state.ready ? "Cached" : "Incomplete"} · ${state.count}${state.total ? `/${state.total}` : ""} files`;
  async function refresh() {
    const id = ++refreshId,
      state = await inspectModelCache();
    if (id !== refreshId) return;
    elements.modelCacheInception.textContent = state.available
      ? describe("Inception", state.inception)
      : "Inception: cache unavailable";
    elements.modelCacheDepth.textContent = state.available
      ? describe("Depth", state.depth)
      : "Depth: cache unavailable";
    elements.modelCacheDownload.disabled = busy || !state.available;
    try {
      const storage = navigator.storage;
      const persistent = Boolean(await storage?.persisted?.());
      elements.modelCachePersist.checked = persistent;
      // The API grants persistence; revocation lives in browser site settings.
      elements.modelCachePersist.disabled = persistent || !storage?.persist;
      elements.modelCachePersistence.textContent = persistent
        ? "Persistent storage granted. Manage it in browser site settings."
        : storage?.persist
          ? "Request protection from automatic storage eviction."
          : "Persistent storage is unavailable.";
    } catch {
      elements.modelCachePersist.disabled = true;
      elements.modelCachePersistence.textContent =
        "Persistent storage is unavailable.";
    }
  }
  elements.modelCacheDrawer.addEventListener("toggle", () => {
    if (elements.modelCacheDrawer.open) void refresh();
  });
  elements.modelCacheDownload.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    elements.modelCacheDownload.disabled = true;
    try {
      const result = await cacheLocalModels({
        onProgress: (p) => {
          elements.modelCacheStatus.textContent = `Caching model files: ${p}%…`;
        },
      });
      elements.modelCacheStatus.textContent =
        result.available && result.inception.ready && result.depth.ready
          ? "Model files are cached locally."
          : "Some files could not be stored. Check available browser storage, then retry.";
    } catch (error) {
      elements.modelCacheStatus.textContent = `Cache download stopped: ${error.message}`;
    } finally {
      busy = false;
      await refresh();
    }
  });
  elements.modelCachePersist.addEventListener("change", async () => {
    if (!elements.modelCachePersist.checked) return;
    elements.modelCachePersist.disabled = true;
    try {
      const granted = await navigator.storage.persist();
      elements.modelCacheStatus.textContent = granted
        ? "Persistent storage granted."
        : "The browser did not grant persistence. Cached files remain available.";
    } catch (error) {
      elements.modelCacheStatus.textContent = `Persistence request failed: ${error.message}`;
    } finally {
      await refresh();
    }
  });
  return { refresh };
}
