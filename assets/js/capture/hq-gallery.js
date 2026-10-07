import { HQ_DB_NAME, HQ_STORE_NAME } from "../app/config.js";
import { downloadBlob } from "../core/utils.js";
import { terminal } from "../ui/terminal.js";

export function createHqGallery({ elements, isRendering, setStatus }) {
  let activeRender = null;
  let sessionRenders = [];
  const renderUrls = new Map();

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = window.indexedDB.open(HQ_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(HQ_STORE_NAME)) {
          request.result.createObjectStore(HQ_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Could not open HQ render storage"));
    });
  }

  async function store(record) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(HQ_STORE_NAME, "readwrite");
      transaction.objectStore(HQ_STORE_NAME).put(record);
      transaction.oncomplete = () => {
        database.close();
        resolve(record);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("Could not store HQ render"));
      };
    });
  }

  async function read() {
    try {
      const database = await openDatabase();
      const stored = await new Promise((resolve, reject) => {
        const request = database
          .transaction(HQ_STORE_NAME, "readonly")
          .objectStore(HQ_STORE_NAME)
          .getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () =>
          reject(request.error || new Error("Could not read HQ renders"));
      });
      database.close();
      const byId = new Map(
        [...stored, ...sessionRenders].map((record) => [record.id, record]),
      );
      return [...byId.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 12);
    } catch {
      return [...sessionRenders];
    }
  }

  async function remove(id) {
    sessionRenders = sessionRenders.filter((record) => record.id !== id);
    const url = renderUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    renderUrls.delete(id);
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(HQ_STORE_NAME, "readwrite");
        transaction.objectStore(HQ_STORE_NAME).delete(id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    } catch {
      // Session-only renders are already removed above.
    }
  }

  function addSession(record) {
    sessionRenders.unshift(record);
  }

  function renderUrl(record) {
    if (!renderUrls.has(record.id)) {
      renderUrls.set(record.id, URL.createObjectURL(record.blob));
    }
    return renderUrls.get(record.id);
  }

  function filename(record) {
    const model = String(record.modelName || "Fractal").replace(
      /[^a-z0-9]+/gi,
      "_",
    );
    return `${model}_SEED_${record.seed}_${record.width}x${record.height}.png`;
  }

  function download(record) {
    const outputName = filename(record);
    downloadBlob(record.blob, outputName);
    terminal("HQ FILE", `${outputName} written`);
    setStatus("HQ PNG EXPORTED");
  }

  function downloadActive() {
    if (activeRender) download(activeRender);
  }

  async function closeViewer({ exitFullscreen = true } = {}) {
    elements.hqViewer.hidden = true;
    elements.outputPanel.classList.remove("is-hq-viewer");
    elements.hqViewerImage.removeAttribute("src");
    activeRender = null;
    if (exitFullscreen && document.fullscreenElement === elements.outputPanel) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  async function openViewer(record) {
    activeRender = record;
    elements.hqViewerImage.src = renderUrl(record);
    elements.hqViewerLabel.textContent = `${record.modelName.toUpperCase()} · SEED ${record.seed} · ${record.width} × ${record.height}`;
    elements.hqViewer.hidden = false;
    elements.outputPanel.classList.add("is-hq-viewer");
    if (document.fullscreenElement !== elements.outputPanel) {
      try {
        await elements.outputPanel.requestFullscreen();
      } catch (error) {
        terminal(
          "FULLSCREEN",
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      }
    }
  }

  async function render() {
    const records = await read();
    elements.hqRenders.hidden = records.length === 0 && !isRendering();
    elements.hqRenderList.replaceChildren();
    records.forEach((record) => {
      const card = document.createElement("article");
      card.className = "hq-render-card";
      const image = document.createElement("img");
      image.src = renderUrl(record);
      image.alt = `${record.modelName} seed ${record.seed}`;
      const info = document.createElement("span");
      info.textContent = `${record.width} × ${record.height} · SEED ${record.seed}`;
      const actions = document.createElement("div");

      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "VIEW";
      view.addEventListener("click", () => openViewer(record));
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "DOWNLOAD";
      save.addEventListener("click", () => download(record));
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "DELETE";
      removeButton.addEventListener("click", async () => {
        await remove(record.id);
        await render();
      });

      actions.append(view, save, removeButton);
      card.append(image, info, actions);
      elements.hqRenderList.append(card);
    });
  }

  function isActive() {
    return Boolean(activeRender);
  }

  function dispose() {
    renderUrls.forEach((url) => URL.revokeObjectURL(url));
    renderUrls.clear();
  }

  return {
    addSession,
    closeViewer,
    dispose,
    downloadActive,
    isActive,
    render,
    store,
  };
}
