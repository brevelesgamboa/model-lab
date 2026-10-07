// Route-local interactions only. Playback remains owned by the app controller.
import { renderModelTechnicalInfo } from "./controls-controller.js";
import { PATTERNS } from "../models/neural-growth/patterns.js";

const FAVORITES_KEY = "latent-field:growth-favorites";
const RECENTS_KEY = "latent-field:growth-recents";

function loadStorageJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function saveStorageJson(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (_) {}
}

export function createGrowthController({
  elements,
  getModel,
  getView,
  render,
  setAnimation,
  setStatus,
  withExclusiveCompute,
}) {
  let busy = false;
  let pointerId = null;
  let lastInfo = null;
  const listeners = [];
  const activeModel = () =>
    getView() === "lab" && getModel()?.id === "neural-growth"
      ? getModel()
      : null;

  // Gallery state
  const favorites = new Set(loadStorageJson(FAVORITES_KEY, []));
  let recents = loadStorageJson(RECENTS_KEY, []);
  let currentTab = "all";
  let searchQuery = "";

  function saveFavorites() {
    saveStorageJson(FAVORITES_KEY, [...favorites]);
    if (elements.growthFavoritesCount) {
      elements.growthFavoritesCount.textContent = String(favorites.size);
    }
  }

  function addRecent(patternId) {
    recents = [patternId, ...recents.filter((id) => id !== patternId)].slice(0, 8);
    saveStorageJson(RECENTS_KEY, recents);
    renderRecents();
  }

  function selectPattern(patternId) {
    const model = activeModel();
    if (!model) return;
    addRecent(patternId);
    const patternSelect = elements.parameterControls?.querySelector(
      'select[aria-label="PATTERN"]',
    );
    if (patternSelect) {
      patternSelect.value = patternId;
      patternSelect.dispatchEvent(new Event("change"));
    } else {
      model.onParameterChange("pattern", patternId);
      render({ forceAnalysis: true });
    }
    renderGalleryGrid();
    elements.growthGalleryDialog?.close();
  }

  function getFilteredPatterns() {
    const q = searchQuery.trim().toLowerCase();
    return PATTERNS.filter((pattern) => {
      if (currentTab === "texture" && pattern.category !== "texture") return false;
      if (currentTab === "inception" && pattern.category !== "inception") return false;
      if (currentTab === "organic" && pattern.category !== "organic") return false;
      if (currentTab === "favorites" && !favorites.has(pattern.id)) return false;
      if (q) {
        const matchName = pattern.name.toLowerCase().includes(q);
        const matchId = pattern.id.toLowerCase().includes(q);
        const matchTech = (pattern.technicalId || "").toLowerCase().includes(q);
        const matchPack = pattern.pack.toLowerCase().includes(q);
        if (!matchName && !matchId && !matchTech && !matchPack) return false;
      }
      return true;
    });
  }

  function renderRecents() {
    if (!elements.growthRecentStrip || !elements.growthRecentItems) return;
    const validRecents = recents.filter((id) =>
      PATTERNS.some((p) => p.id === id),
    );
    if (validRecents.length === 0) {
      elements.growthRecentStrip.hidden = true;
      return;
    }
    elements.growthRecentStrip.hidden = false;
    elements.growthRecentItems.replaceChildren();
    for (const id of validRecents) {
      const pattern = PATTERNS.find((p) => p.id === id);
      if (!pattern) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "growth-gallery__recent-btn";
      btn.textContent = pattern.name;
      btn.addEventListener("click", () => selectPattern(pattern.id));
      elements.growthRecentItems.appendChild(btn);
    }
  }

  function renderGalleryGrid() {
    if (!elements.growthGalleryGrid) return;
    const model = activeModel();
    const activePatternId =
      model?.activePattern || model?.parameters?.pattern || "mixed4c-439";
    const filtered = getFilteredPatterns();

    if (elements.growthGalleryCount) {
      elements.growthGalleryCount.textContent = `${filtered.length} pattern${filtered.length === 1 ? "" : "s"}`;
    }
    if (elements.growthFavoritesCount) {
      elements.growthFavoritesCount.textContent = String(favorites.size);
    }

    elements.growthGalleryGrid.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "growth-gallery__empty";
      empty.style.gridColumn = "1 / -1";
      empty.style.padding = "2rem";
      empty.style.textAlign = "center";
      empty.style.color = "var(--muted)";
      empty.style.font = "12px var(--mono)";
      empty.textContent =
        currentTab === "favorites"
          ? "No favorite patterns saved yet. Click the star on any card to bookmark it."
          : `No patterns found matching "${searchQuery}".`;
      elements.growthGalleryGrid.appendChild(empty);
      return;
    }

    for (const pattern of filtered) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "growth-gallery__card";
      card.dataset.patternId = pattern.id;
      if (pattern.id === activePatternId) {
        card.classList.add("is-selected");
        card.setAttribute("aria-selected", "true");
      }

      const thumbWrapper = document.createElement("div");
      thumbWrapper.className = "growth-gallery__thumb-wrapper";

      const thumb = document.createElement("img");
      thumb.className = "growth-gallery__thumb";
      thumb.src = pattern.previewUrl.href;
      thumb.alt = pattern.name;
      thumb.loading = "lazy";
      thumb.width = 128;
      thumb.height = 128;

      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "growth-gallery__fav-btn";
      favBtn.title = favorites.has(pattern.id)
        ? "Remove from favorites"
        : "Add to favorites";
      favBtn.textContent = favorites.has(pattern.id) ? "★" : "☆";
      if (favorites.has(pattern.id)) favBtn.classList.add("is-fav");

      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (favorites.has(pattern.id)) {
          favorites.delete(pattern.id);
          favBtn.textContent = "☆";
          favBtn.classList.remove("is-fav");
        } else {
          favorites.add(pattern.id);
          favBtn.textContent = "★";
          favBtn.classList.add("is-fav");
        }
        saveFavorites();
        if (currentTab === "favorites") {
          renderGalleryGrid();
        }
      });

      thumbWrapper.append(thumb, favBtn);

      const nameEl = document.createElement("div");
      nameEl.className = "growth-gallery__card-name";
      nameEl.textContent = pattern.name;

      const idEl = document.createElement("div");
      idEl.className = "growth-gallery__card-id";
      idEl.textContent = pattern.technicalId || pattern.id;

      const badge = document.createElement("span");
      badge.className = `growth-gallery__card-badge growth-gallery__card-badge--${pattern.category}`;
      badge.textContent =
        pattern.category === "texture"
          ? "Texture"
          : pattern.category === "inception"
            ? "Inception"
            : "Original";

      card.append(thumbWrapper, nameEl, idEl, badge);

      card.addEventListener("click", () => {
        selectPattern(pattern.id);
      });

      elements.growthGalleryGrid.appendChild(card);
    }
  }

  function update() {
    const model = activeModel();
    elements.growthTools.hidden = !model;
    elements.canvas.classList.toggle("is-growth", Boolean(model));
    if (!model) return;
    if (model.technicalInfo !== lastInfo) {
      renderModelTechnicalInfo(elements, model);
      lastInfo = model.technicalInfo;
    }
    const stats = model.getStats();
    elements.growthStatus.textContent = model.lastError
      ? `${model.lastError} Use Restart to retry.`
      : model.state === "LOADING"
        ? "Loading pattern; retaining the current field…"
        : stats
          ? `${stats.size} × ${stats.size} · ${stats.steps} updates · click or drag to disturb`
          : "Initializing WebGL2 field…";
    elements.growthStatus.dataset.steps = String(stats?.steps || 0);
    elements.growthStatus.dataset.size = String(stats?.size || 0);
    elements.stepGrowth.disabled = busy || !model.ready;
    elements.disturbGrowth.disabled = busy || !model.ready;
    elements.restartGrowth.disabled = busy;
    if (elements.openGrowthGallery) {
      elements.openGrowthGallery.disabled = busy;
    }
  }

  async function act(operation, { pause = false } = {}) {
    const model = activeModel();
    if (!model || busy) return;
    busy = true;
    if (pause) setAnimation(false);
    update();
    try {
      await withExclusiveCompute(() => {
        if (activeModel() === model) operation(model);
      });
      if (activeModel() === model) await render({ forceAnalysis: true });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      update();
    }
  }

  let lastCoord = null;
  let pendingPausedRender = false;

  function schedulePausedRender() {
    if (pendingPausedRender) return;
    pendingPausedRender = true;
    requestAnimationFrame(async () => {
      pendingPausedRender = false;
      const model = activeModel();
      if (!model || model.isClockRunning) return;
      try {
        await render({ forceAnalysis: true });
      } catch (_) {}
    });
  }

  function getGridCoords(event, model) {
    const rect = elements.canvas.getBoundingClientRect();
    const side = Math.min(rect.width, rect.height);
    if (!side) return null;
    let x = (event.clientX - rect.left - (rect.width - side) / 2) / side;
    let y = (event.clientY - rect.top - (rect.height - side) / 2) / side;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return null;
    const zoom = Math.max(1, Math.min(8, Number(model.parameters?.zoom) || 1));
    if (zoom > 1) {
      x = 0.5 + (x - 0.5) / zoom;
      y = 0.5 + (y - 0.5) / zoom;
    }
    const size = model.simulationSize;
    return {
      gx: Math.max(0, Math.min(size - 1, Math.floor(x * size))),
      gy: Math.max(0, Math.min(size - 1, size - 1 - Math.floor(y * size))),
    };
  }

  function handlePointerDown(event) {
    const model = activeModel();
    if (!model?.ready || event.button !== 0) return;
    pointerId = event.pointerId;
    try {
      elements.canvas.setPointerCapture(pointerId);
    } catch (_) {}
    const coords = getGridCoords(event, model);
    if (!coords) return;
    lastCoord = coords;
    const radius = Number(model.parameters?.brushRadius) || 8;
    const mode = model.parameters?.disturbanceMode || "erase";
    model.queueDisturbance(coords.gx, coords.gy, radius, mode);
    if (!model.isClockRunning) {
      schedulePausedRender();
    }
  }

  function handlePointerMove(event) {
    const model = activeModel();
    if (!model?.ready || pointerId !== event.pointerId || event.buttons !== 1) return;
    const coords = getGridCoords(event, model);
    if (!coords) return;
    const radius = Number(model.parameters?.brushRadius) || 8;
    const mode = model.parameters?.disturbanceMode || "erase";
    if (lastCoord) {
      model.queueDisturbanceStroke(lastCoord.gx, lastCoord.gy, coords.gx, coords.gy, radius, mode);
    } else {
      model.queueDisturbance(coords.gx, coords.gy, radius, mode);
    }
    lastCoord = coords;
    if (!model.isClockRunning) {
      schedulePausedRender();
    }
  }

  const release = (event) => {
    if (
      pointerId !== null &&
      (event?.pointerId === undefined || event.pointerId === pointerId)
    ) {
      try {
        if (elements.canvas.hasPointerCapture?.(pointerId)) {
          elements.canvas.releasePointerCapture(pointerId);
        }
      } catch (_) {}
      pointerId = null;
      lastCoord = null;
    }
  };

  function listen(target, type, callback) {
    if (!target) return;
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }

  listen(elements.stepGrowth, "click", () =>
    act((model) => model.step(), { pause: true }),
  );
  listen(elements.restartGrowth, "click", () =>
    act((model) => model.restart()),
  );
  listen(elements.disturbGrowth, "click", () => {
    const model = activeModel();
    if (!model?.ready) return;
    const center = Math.floor(model.simulationSize / 2);
    const radius = Number(model.parameters?.brushRadius) || 8;
    const mode = model.parameters?.disturbanceMode || "erase";
    model.queueDisturbance(center, center, radius, mode);
    if (!model.isClockRunning) {
      schedulePausedRender();
    }
  });

  // Gallery events
  if (elements.openGrowthGallery && elements.growthGalleryDialog) {
    listen(elements.openGrowthGallery, "click", () => {
      renderGalleryGrid();
      renderRecents();
      elements.growthGalleryDialog.showModal();
      elements.growthGallerySearch?.focus();
    });

    listen(elements.closeGrowthGallery, "click", () => {
      elements.growthGalleryDialog.close();
    });

    listen(elements.growthGalleryDialog, "click", (event) => {
      if (event.target === elements.growthGalleryDialog) {
        elements.growthGalleryDialog.close();
      }
    });

    listen(elements.growthGallerySearch, "input", (event) => {
      searchQuery = event.target.value;
      renderGalleryGrid();
    });

    if (elements.growthGalleryTabs) {
      listen(elements.growthGalleryTabs, "click", (event) => {
        const tab = event.target.closest(".growth-gallery__tab");
        if (!tab || !tab.dataset.filter) return;
        currentTab = tab.dataset.filter;
        elements.growthGalleryTabs
          .querySelectorAll(".growth-gallery__tab")
          .forEach((t) => t.classList.toggle("is-active", t === tab));
        renderGalleryGrid();
      });
    }
  }

  listen(elements.canvas, "pointerdown", handlePointerDown);
  listen(elements.canvas, "pointermove", handlePointerMove);
  listen(elements.canvas, "pointerup", release);
  listen(elements.canvas, "pointercancel", release);
  listen(elements.canvas, "lostpointercapture", release);
  return { update, dispose: () => listeners.forEach((remove) => remove()) };
}
