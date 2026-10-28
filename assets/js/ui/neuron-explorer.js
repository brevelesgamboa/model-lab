import { INCEPTION_LAYER_CHANNELS } from "../models/neural-growth/inception-layers.js";
import { createNeuronPreview } from "./neuron-preview.js";

const PAGE_SIZE = 12;
const previewKey = (layer, channel) => `${layer}_${channel}`;
const channelName = (channel) =>
  channel < 0 ? "All channels" : `Channel #${channel}`;

export function createNeuronExplorer({
  parameters,
  neurons,
  previewBridge,
  onSelect,
  onSensorSelect,
}) {
  let values = parameters;
  let disposed = false;
  let detailAbort = null;
  let detailTarget = null;
  let searchTimer = null;
  let page = 0;
  let visibleCards = [];
  let favorites = new Set();
  let recents = [];
  let libraryKey = "";
  let plannedCount = 0;
  const validKey = (key) => {
    if (typeof key !== "string") return false;
    const split = key.lastIndexOf("_");
    const layer = key.slice(0, split);
    const channel = Number(key.slice(split + 1));
    return (
      Object.hasOwn(INCEPTION_LAYER_CHANNELS, layer) &&
      Number.isInteger(channel) &&
      channel >= -1 &&
      channel < INCEPTION_LAYER_CHANNELS[layer]
    );
  };
  const labels = new Map(
    neurons.map((neuron) => [
      previewKey(neuron.layer, neuron.channel),
      neuron.name,
    ]),
  );

  const preview = createNeuronPreview({ parameters, previewBridge });
  const selectedPreview = preview.element;

  const dialog = document.createElement("dialog");
  dialog.className = "neuron-explorer";
  dialog.setAttribute("aria-labelledby", "neuron-explorer-title");
  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.id = "neuron-explorer-title";
  heading.textContent = "Neuron explorer";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mini-button";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close neuron explorer");
  header.append(heading, close);
  const note = document.createElement("p");
  note.className = "neuron-explorer__note";
  const purpose = onSensorSelect
    ? onSelect
      ? "a visual sensor or Dream target"
      : "a visual sensor"
    : "a Dream target";
  note.textContent = `InceptionV3 · Inspect a channel, then use it as ${purpose}. Previews show optimized feature examples. New previews generate only when you ask.`;
  const toolbar = document.createElement("div");
  toolbar.className = "neuron-explorer__toolbar";
  const layerLabel = document.createElement("label");
  layerLabel.textContent = "Layer ";
  const layerSelect = document.createElement("select");
  layerSelect.setAttribute("aria-label", "Explorer layer");
  const allLayers = document.createElement("option");
  allLayers.value = "all";
  allLayers.textContent = "All layers";
  layerSelect.append(allLayers);
  for (const [name, prefix] of [
    ["Stem layers", "Conv2d_"],
    ["Earlier layers", "mixed_5"],
    ["Middle layers", "mixed_6"],
    ["Later layers", "mixed_7"],
  ]) {
    const group = document.createElement("optgroup");
    group.label = name;
    for (const [layer, count] of Object.entries(INCEPTION_LAYER_CHANNELS)) {
      if (!layer.startsWith(prefix)) continue;
      const option = document.createElement("option");
      option.value = layer;
      option.textContent = `${layer} · ${count} channels`;
      group.append(option);
    }
    layerSelect.append(group);
  }
  layerLabel.append(layerSelect);
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Channel number or curated name";
  search.setAttribute("aria-label", "Find neuron channel");
  const collectionLabel = document.createElement("label");
  collectionLabel.textContent = "Show ";
  const collection = document.createElement("select");
  collection.setAttribute("aria-label", "Preview collection");
  for (const [value, text] of [
    ["available", "Available previews"],
    ["all", "All channels"],
    ["favorites", "Favorite neurons"],
    ["recent", "Recently viewed"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    collection.append(option);
  }
  collectionLabel.append(collection);
  toolbar.append(layerLabel, collectionLabel, search);
  const cacheControls = document.createElement("div");
  cacheControls.className = "neuron-explorer__cache";
  const cacheLabel = document.createElement("label");
  const savePreviews = document.createElement("input");
  savePreviews.type = "checkbox";
  cacheLabel.append(savePreviews, " Save previews on this device");
  const cacheStatus = document.createElement("span");
  cacheStatus.setAttribute("role", "status");
  const clearCache = document.createElement("button");
  clearCache.type = "button";
  clearCache.className = "mini-button";
  clearCache.textContent = "Clear saved previews";
  cacheControls.append(cacheLabel, cacheStatus, clearCache);
  function updateCacheStatus() {
    const status = previewBridge?.previewStorage?.status;
    savePreviews.checked = status?.enabled ?? false;
    cacheStatus.textContent = !status?.available
      ? "Saving unavailable; previews last for this visit."
      : !status.enabled
        ? "Saving off; existing saved previews are kept."
        : `${status.count} saved · up to ${status.limit} / 64 MiB, reused after reload`;
    clearCache.disabled =
      !status ||
      (!status.available && !status.count) ||
      (status.enabled && !status.count);
  }
  savePreviews.addEventListener("change", async () => {
    savePreviews.disabled = true;
    try {
      await previewBridge?.setSavePreviews(savePreviews.checked);
      if (dialog.open && !disposed) renderPage();
    } finally {
      savePreviews.disabled = false;
      updateCacheStatus();
    }
  });
  clearCache.addEventListener("click", async () => {
    clearCache.disabled = true;
    const cleared = await previewBridge?.clearSavedPreviews();
    updateCacheStatus();
    if (cleared)
      cacheStatus.textContent =
        "Saved previews cleared. Current previews remain for this visit.";
  });
  const unsubscribeStorage =
    previewBridge?.previewStorage?.subscribe(updateCacheStatus);
  updateCacheStatus();
  const backgroundControls = document.createElement("details");
  backgroundControls.className = "neuron-explorer__background";
  backgroundControls.setAttribute("aria-label", "Background preview cache");
  const backgroundSummary = document.createElement("summary");
  backgroundSummary.textContent = "Generate previews in background";
  const backgroundOptions = document.createElement("div");
  backgroundOptions.className = "neuron-explorer__background-options";
  const scopeLabel = document.createElement("label");
  scopeLabel.textContent = "Background batch ";
  const scope = document.createElement("select");
  scope.setAttribute("aria-label", "Background batch scope");
  for (const [value, text] of [
    ["page", "This page"],
    ["layer", "Whole layer"],
    ["range", "Channel range"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    scope.append(option);
  }
  scopeLabel.append(scope);
  const rangeInputs = document.createElement("span");
  rangeInputs.className = "neuron-explorer__batch-range";
  rangeInputs.hidden = true;
  const rangeStart = document.createElement("input");
  const rangeEnd = document.createElement("input");
  for (const [input, name, initial] of [
    [rangeStart, "First background channel", 0],
    [rangeEnd, "Last background channel", 47],
  ]) {
    input.type = "number";
    input.min = "-1";
    input.step = "1";
    input.value = initial;
    input.setAttribute("aria-label", name);
  }
  rangeInputs.append(rangeStart, " to ", rangeEnd);
  const batchCount = document.createElement("span");
  const startBackground = document.createElement("button");
  startBackground.type = "button";
  startBackground.className = "mini-button";
  startBackground.textContent = "Start background cache";
  const backgroundStatus = document.createElement("span");
  backgroundStatus.setAttribute("role", "status");
  const backgroundNote = document.createElement("p");
  backgroundNote.textContent =
    "Skips cached previews. Continues when this panel closes; stops when you close this tab.";
  const compactBackground = document.createElement("div");
  compactBackground.className = "neuron-background-progress";
  compactBackground.hidden = true;
  const compactStatus = document.createElement("span");
  compactStatus.setAttribute("role", "status");
  compactBackground.append(compactStatus);
  selectedPreview.append(compactBackground);
  const backgroundActions = [];
  for (const parent of [backgroundOptions, compactBackground]) {
    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "mini-button";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mini-button";
    cancel.textContent = "Cancel background cache";
    pause.addEventListener("click", () =>
      previewBridge.pauseBackgroundPreviews(
        previewBridge.backgroundPreviewStatus.phase !== "paused",
      ),
    );
    cancel.addEventListener("click", () =>
      previewBridge.cancelBackgroundPreviews(),
    );
    parent.append(pause, cancel);
    backgroundActions.push({ pause, cancel });
  }
  backgroundOptions.prepend(
    scopeLabel,
    rangeInputs,
    batchCount,
    startBackground,
    backgroundStatus,
  );
  backgroundOptions.append(backgroundNote);
  backgroundControls.append(backgroundSummary, backgroundOptions);
  function backgroundChoices() {
    const layer =
      layerSelect.value === "all" ? values.targetLayer : layerSelect.value;
    let choices;
    if (scope.value === "page") choices = visibleCards;
    else {
      if (scope.value === "range" && (!rangeStart.value || !rangeEnd.value))
        return [];
      const first = scope.value === "layer" ? -1 : Number(rangeStart.value);
      const last =
        scope.value === "layer"
          ? INCEPTION_LAYER_CHANNELS[layer] - 1
          : Number(rangeEnd.value);
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < -1 ||
        last >= INCEPTION_LAYER_CHANNELS[layer] ||
        first > last
      )
        return [];
      choices = Array.from({ length: last - first + 1 }, (_, i) => ({
        layer,
        channel: first + i,
      }));
    }
    return choices.filter(
      ({ layer, channel }) =>
        !previewBridge?.previewCache.has(previewKey(layer, channel)),
    );
  }
  function updateBackground(refreshCount = true) {
    const status = previewBridge?.backgroundPreviewStatus;
    const active = status && ["running", "paused"].includes(status.phase);
    if (refreshCount) plannedCount = backgroundChoices().length;
    const invalidRange =
      scope.value === "range" &&
      (!rangeStart.value ||
        !rangeEnd.value ||
        !rangeStart.checkValidity() ||
        !rangeEnd.checkValidity() ||
        Number(rangeStart.value) > Number(rangeEnd.value));
    batchCount.textContent = invalidRange
      ? "Enter a valid channel range."
      : `${plannedCount} uncached previews`;
    startBackground.disabled =
      active ||
      !plannedCount ||
      !previewBridge?.previewStorage.status.enabled ||
      !previewBridge?.previewStorage.status.available;
    const prefix =
      status?.phase === "paused"
        ? "Background cache paused"
        : status?.phase === "complete"
          ? "Background cache complete"
          : status?.phase === "cancelled"
            ? "Background cache cancelled"
            : status?.phase === "error"
              ? "Background cache stopped; check preview saving"
              : "Background cache";
    const text = !status?.total
      ? "Starts only when you click."
      : `${prefix} · ${status.completed}/${status.total}${status.failed ? ` · ${status.failed} failed` : ""}${active && status.current ? ` · ${Math.round(status.progress * 100)}% of current preview` : ""}`;
    backgroundStatus.textContent = compactStatus.textContent = text;
    backgroundSummary.textContent = active
      ? `${prefix} · ${status.completed}/${status.total}`
      : "Generate previews in background";
    compactBackground.hidden = !active;
    for (const { pause, cancel } of backgroundActions) {
      pause.hidden = cancel.hidden = !active;
      pause.textContent =
        status?.phase === "paused"
          ? "Resume background cache"
          : "Pause background cache";
    }
  }
  startBackground.addEventListener("click", () => {
    void previewBridge.startBackgroundPreviews(backgroundChoices());
    updateBackground();
  });
  scope.addEventListener("change", () => {
    rangeInputs.hidden = scope.value !== "range";
    if (scope.value !== "page" && layerSelect.value === "all")
      layerSelect.value = values.targetLayer;
    renderPage();
  });
  for (const input of [rangeStart, rangeEnd])
    input.addEventListener("input", () => {
      updateBackground();
      saveLibrary();
    });
  const unsubscribeBackground = previewBridge?.subscribeBackgroundPreviews(() =>
    updateBackground(false),
  );
  const unsubscribeBackgroundStorage =
    previewBridge?.previewStorage?.subscribe(updateBackground);
  const grid = document.createElement("div");
  grid.className = "neuron-explorer__grid";
  grid.setAttribute("aria-label", "Channels in selected layer");
  const navigation = document.createElement("nav");
  navigation.className = "neuron-explorer__pagination";
  navigation.setAttribute("aria-label", "Neuron pages");
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "Previous";
  previous.setAttribute("aria-label", "Previous neuron page");
  const range = document.createElement("span");
  range.setAttribute("role", "status");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next";
  next.setAttribute("aria-label", "Next neuron page");
  navigation.append(previous, range, next);
  dialog.append(
    header,
    note,
    toolbar,
    cacheControls,
    backgroundControls,
    grid,
    navigation,
  );
  document.body.append(dialog);

  function saveLibrary() {
    if (!libraryKey) return;
    try {
      localStorage.setItem(
        libraryKey,
        JSON.stringify({
          favorites: [...favorites],
          recents,
          layer: layerSelect.value,
          collection: collection.value,
          query: search.value,
          page,
          scope: scope.value,
          first: rangeStart.value,
          last: rangeEnd.value,
          backgroundOpen: backgroundControls.open,
        }),
      );
    } catch {
      /* Browsing also works without storage. */
    }
  }

  function restoreLibrary() {
    libraryKey = `latent-field:neuron-explorer:${previewBridge?.previewCheckpointId || "inception-v3"}`;
    try {
      const saved = JSON.parse(localStorage.getItem(libraryKey));
      if (!saved || typeof saved !== "object") return;
      favorites = new Set(
        Array.isArray(saved.favorites)
          ? saved.favorites.filter(validKey).slice(0, 4096)
          : [],
      );
      recents = Array.isArray(saved.recents)
        ? saved.recents.filter(validKey).slice(0, 24)
        : [];
      layerSelect.value = Object.hasOwn(INCEPTION_LAYER_CHANNELS, saved.layer)
        ? saved.layer
        : "all";
      collection.value = ["available", "all", "favorites", "recent"].includes(
        saved.collection,
      )
        ? saved.collection
        : "available";
      if (collection.value === "all" && layerSelect.value === "all")
        layerSelect.value = values.targetLayer;
      allLayers.disabled = collection.value === "all";
      search.value =
        typeof saved.query === "string" ? saved.query.slice(0, 120) : "";
      page =
        Number.isSafeInteger(saved.page) && saved.page >= 0 ? saved.page : 0;
      scope.value = ["page", "layer", "range"].includes(saved.scope)
        ? saved.scope
        : "page";
      rangeStart.value = String(
        Number.isInteger(Number(saved.first))
          ? Math.max(-1, Math.min(2047, Number(saved.first)))
          : 0,
      );
      rangeEnd.value = String(
        Number.isInteger(Number(saved.last))
          ? Math.max(-1, Math.min(2047, Number(saved.last)))
          : 47,
      );
      rangeInputs.hidden = scope.value !== "range";
      backgroundControls.open = saved.backgroundOpen === true;
    } catch {
      /* Use the initial view if saved preferences are unavailable. */
    }
  }

  const detail = document.createElement("section");
  detail.className = "neuron-explorer__detail";
  detail.hidden = true;
  const detailHeading = document.createElement("h3");
  const detailImage = document.createElement("img");
  detailImage.width = detailImage.height = 256;
  detailImage.hidden = true;
  const detailStatus = document.createElement("p");
  detailStatus.setAttribute("role", "status");
  const detailActions = document.createElement("div");
  const generateDetail = document.createElement("button");
  generateDetail.type = "button";
  generateDetail.className = "mini-button";
  generateDetail.textContent = "Generate neuron preview";
  const applyDetail = document.createElement("button");
  applyDetail.type = "button";
  applyDetail.className = "mini-button";
  applyDetail.textContent = "Use as Dream target";
  applyDetail.hidden = !onSelect;
  const applySensor = document.createElement("button");
  applySensor.type = "button";
  applySensor.className = "mini-button";
  applySensor.textContent = "Use as sensor";
  applySensor.hidden = !onSensorSelect;
  const favoriteDetail = document.createElement("button");
  favoriteDetail.type = "button";
  favoriteDetail.className = "mini-button";
  const closeDetail = document.createElement("button");
  closeDetail.type = "button";
  closeDetail.className = "mini-button";
  closeDetail.textContent = "Close preview details";
  detailActions.append(
    generateDetail,
    applyDetail,
    applySensor,
    favoriteDetail,
    closeDetail,
  );
  detail.append(detailHeading, detailImage, detailStatus, detailActions);

  function showDetailImage(url) {
    detailImage.src = url;
    detailImage.hidden = false;
    generateDetail.hidden = true;
    detailStatus.textContent =
      "Cached feature visualization · InceptionV3 · 96 × 96. This is an optimized example, not a live view of the canvas.";
  }

  function inspect(layer, channel) {
    detailAbort?.abort();
    detailAbort = null;
    detailTarget = { layer, channel };
    applySensor.disabled = channel < 0;
    applySensor.title =
      channel < 0
        ? "Choose a single channel to use as a sensor."
        : "Measure this channel on the live canvas. Existing Inception routes use the selection.";
    const key = previewKey(layer, channel);
    recents = [key, ...recents.filter((item) => item !== key)].slice(0, 24);
    saveLibrary();
    detailHeading.textContent = `${layer} · ${channelName(channel)}`;
    detailImage.alt = `Feature visualization · ${detailHeading.textContent}`;
    detailImage.hidden = true;
    detailImage.removeAttribute("src");
    detailStatus.textContent =
      "No preview yet. Generate one here or include this channel in a background batch.";
    generateDetail.textContent = "Generate neuron preview";
    generateDetail.hidden = false;
    generateDetail.disabled = false;
    favoriteDetail.textContent = favorites.has(key)
      ? "Remove neuron favorite"
      : "Save neuron favorite";
    favoriteDetail.setAttribute("aria-pressed", String(favorites.has(key)));
    const cached = previewBridge?.previewCache.get(key);
    if (cached) showDetailImage(cached);
    detail.hidden = false;
    grid.prepend(detail);
    detail.scrollIntoView({ block: "nearest" });
  }

  generateDetail.addEventListener("click", async () => {
    detailAbort?.abort();
    const abort = new AbortController();
    detailAbort = abort;
    const target = detailTarget;
    generateDetail.disabled = true;
    detailStatus.textContent = "Generating feature preview…";
    try {
      const url = await previewBridge.requestPreview(
        target.layer,
        target.channel,
        {
          signal: abort.signal,
          retry: true,
          onProgress: (step, total) => {
            if (!abort.signal.aborted)
              detailStatus.textContent = `Generating · ${Math.round((step / total) * 100)}%`;
          },
        },
      );
      if (!abort.signal.aborted && !disposed && detailTarget === target)
        showDetailImage(url);
    } catch {
      if (!abort.signal.aborted && !disposed) {
        detailStatus.textContent = "Preview unavailable. You can retry.";
        generateDetail.textContent = "Retry neuron detail preview";
      }
    } finally {
      if (detailTarget === target) generateDetail.disabled = false;
    }
  });
  applyDetail.addEventListener("click", () => {
    const { layer, channel } = detailTarget;
    onSelect({ layer, channel, name: `${layer} · ${channelName(channel)}` });
    dialog.close();
  });
  applySensor.addEventListener("click", () => {
    if (!detailTarget || detailTarget.channel < 0) return;
    onSensorSelect(detailTarget);
    dialog.close();
  });
  function toggleFavorite(layer, channel) {
    const key = previewKey(layer, channel);
    if (favorites.has(key)) favorites.delete(key);
    else favorites.add(key);
    if (
      detailTarget &&
      previewKey(detailTarget.layer, detailTarget.channel) === key
    ) {
      favoriteDetail.textContent = favorites.has(key)
        ? "Remove neuron favorite"
        : "Save neuron favorite";
      favoriteDetail.setAttribute("aria-pressed", String(favorites.has(key)));
    }
    saveLibrary();
    renderPage();
  }
  favoriteDetail.addEventListener("click", () =>
    toggleFavorite(detailTarget.layer, detailTarget.channel),
  );
  closeDetail.addEventListener("click", () => {
    detailAbort?.abort();
    detailTarget = null;
    detail.hidden = true;
    detail.remove();
  });
  backgroundControls.addEventListener("toggle", saveLibrary);

  function update(parameters) {
    values = parameters;
    preview.update(parameters);
    for (const { card, layer, channel } of visibleCards)
      card.setAttribute(
        "aria-pressed",
        String(
          layer === values.targetLayer && channel === values.targetChannel,
        ),
      );
  }

  function renderPage() {
    const query = search.value.trim().toLowerCase().replace(/^#/, "");
    const choices = Object.entries(INCEPTION_LAYER_CHANNELS)
      .filter(
        ([layer]) => layerSelect.value === "all" || layerSelect.value === layer,
      )
      .flatMap(([layer, count]) =>
        Array.from({ length: count + 1 }, (_, i) => ({
          layer,
          channel: i - 1,
        })),
      )
      .filter(
        ({ layer, channel }) =>
          collection.value === "all" ||
          (collection.value === "favorites"
            ? favorites.has(previewKey(layer, channel))
            : collection.value === "recent"
              ? recents.includes(previewKey(layer, channel))
              : previewBridge?.previewCache.has(previewKey(layer, channel))),
      )
      .filter(
        ({ layer, channel }) =>
          !query ||
          (/^\d+$/.test(query)
            ? channel === Number(query)
            : `${channelName(channel)} ${layer} ${labels.get(previewKey(layer, channel)) || ""}`
                .toLowerCase()
                .includes(query)),
      );
    if (collection.value === "recent")
      choices.sort(
        (a, b) =>
          recents.indexOf(previewKey(a.layer, a.channel)) -
          recents.indexOf(previewKey(b.layer, b.channel)),
      );
    const pages = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    range.textContent = choices.length
      ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, choices.length)} of ${choices.length} choices`
      : "No matching channels";
    visibleCards = [];
    grid.replaceChildren();
    if (detailTarget) grid.append(detail);
    if (!choices.length) {
      const empty = document.createElement("p");
      empty.className = "neuron-explorer__empty";
      empty.textContent =
        "No matching neurons. Choose All channels to browse; generation starts only when requested.";
      grid.append(empty);
    }
    let previousGroup = "";
    for (const { layer, channel } of choices.slice(
      page * PAGE_SIZE,
      (page + 1) * PAGE_SIZE,
    )) {
      const group = layer.startsWith("Conv2d_")
        ? "Stem layers"
        : layer.startsWith("mixed_5")
          ? "Earlier layers"
          : layer.startsWith("mixed_6")
            ? "Middle layers"
            : "Later layers";
      if (layerSelect.value === "all" && group !== previousGroup) {
        const heading = document.createElement("h3");
        heading.className = "neuron-explorer__layer-heading";
        heading.textContent = group;
        grid.append(heading);
        previousGroup = group;
      }
      const key = previewKey(layer, channel);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "neuron-explorer__card";
      card.dataset.layer = layer;
      card.dataset.channel = channel;
      card.setAttribute("aria-label", `${layer} · ${channelName(channel)}`);
      const image = document.createElement("img");
      image.width = image.height = 128;
      image.alt = `Feature visualization · ${layer} · ${channelName(channel)}`;
      image.hidden = true;
      const caption = document.createElement("strong");
      caption.textContent = channelName(channel);
      const layerBadge = document.createElement("span");
      layerBadge.className = "neuron-explorer__layer";
      layerBadge.textContent = layer;
      const status = document.createElement("span");
      status.className = "neuron-explorer__card-status";
      status.textContent = "Preview not generated · select to inspect";
      card.append(image, layerBadge, caption, status);
      if (labels.has(key)) {
        const label = document.createElement("span");
        label.className = "neuron-explorer__curated";
        label.textContent = `Curated suggestion: ${labels.get(key)}`;
        card.append(label);
      }
      card.setAttribute(
        "aria-pressed",
        String(
          layer === values.targetLayer && channel === values.targetChannel,
        ),
      );
      card.addEventListener("click", () => inspect(layer, channel));
      visibleCards.push({ card, image, status, key, layer, channel });
      const tile = document.createElement("div");
      tile.className = "neuron-explorer__tile";
      const star = document.createElement("button");
      star.type = "button";
      star.className = "neuron-explorer__favorite";
      star.textContent = favorites.has(key) ? "★" : "☆";
      star.setAttribute(
        "aria-label",
        `Favorite ${layer} ${channelName(channel)}`,
      );
      star.setAttribute("aria-pressed", String(favorites.has(key)));
      star.addEventListener("click", () => toggleFavorite(layer, channel));
      tile.append(card, star);
      grid.append(tile);
      const cached = previewBridge?.previewCache.get(key);
      if (cached) {
        image.src = cached;
        image.hidden = false;
        status.textContent = "";
      }
    }
    const layer =
      layerSelect.value === "all" ? values.targetLayer : layerSelect.value;
    rangeStart.max = rangeEnd.max = String(INCEPTION_LAYER_CHANNELS[layer] - 1);
    updateBackground();
    saveLibrary();
  }

  async function open({ inspectTarget = null } = {}) {
    if (dialog.open || disposed) return;
    dialog.showModal();
    await previewBridge?.loadPreviews?.();
    if (disposed || !dialog.open) return;
    restoreLibrary();
    renderPage();
    if (inspectTarget) inspect(inspectTarget.layer, inspectTarget.channel);
    else
      grid
        .querySelector('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest" });
    layerSelect.focus({ preventScroll: true });
  }
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    clearTimeout(searchTimer);
    detailAbort?.abort();
    if (!generateDetail.hidden) generateDetail.disabled = false;
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  collection.addEventListener("change", () => {
    allLayers.disabled = collection.value === "all";
    if (allLayers.disabled && layerSelect.value === "all")
      layerSelect.value = values.targetLayer;
    page = 0;
    renderPage();
  });
  layerSelect.addEventListener("change", () => {
    page = 0;
    renderPage();
  });
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 0;
      renderPage();
    }, 150);
  });
  previous.addEventListener("click", () => {
    page -= 1;
    renderPage();
  });
  next.addEventListener("click", () => {
    page += 1;
    renderPage();
  });
  const unsubscribe = previewBridge?.subscribePreviews((key, url) => {
    if (disposed) return;
    for (const item of visibleCards) {
      if (item.key !== key) continue;
      item.image.src = url;
      item.image.hidden = false;
      item.status.textContent = "";
    }
    if (
      detailTarget &&
      previewKey(detailTarget.layer, detailTarget.channel) === key
    )
      showDetailImage(url);
    updateBackground();
  });
  update(parameters);
  updateBackground();
  return {
    selectedPreview,
    open,
    update,
    dispose() {
      disposed = true;
      clearTimeout(searchTimer);
      preview.dispose();
      detailAbort?.abort();
      unsubscribe?.();
      unsubscribeStorage?.();
      unsubscribeBackground?.();
      unsubscribeBackgroundStorage?.();
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
