import { INCEPTION_LAYER_CHANNELS } from "../models/neural-growth/dream-guidance.js";

const PAGE_SIZE = 12;
const previewKey = (layer, channel) => `${layer}_${channel}`;
const channelName = (channel) =>
  channel < 0 ? "All channels" : `Channel #${channel}`;

export function createNeuronExplorer({
  parameters,
  neurons,
  previewBridge,
  onSelect,
}) {
  let values = parameters;
  let disposed = false;
  let selectedKey = "";
  let selectedAbort = null;
  let pageAbort = null;
  let timer = null;
  let searchTimer = null;
  let page = 0;
  let visibleCards = [];
  const labels = new Map(
    neurons.map((neuron) => [
      previewKey(neuron.layer, neuron.channel),
      neuron.name,
    ]),
  );

  const selectedPreview = document.createElement("figure");
  selectedPreview.className = "neuron-selected-preview";
  selectedPreview.setAttribute("aria-label", "Selected neuron preview");
  const selectedImage = document.createElement("img");
  selectedImage.width = selectedImage.height = 128;
  selectedImage.hidden = true;
  selectedImage.addEventListener("error", () => {
    if (disposed || selectedImage.hidden) return;
    previewBridge?.previewCache.delete(selectedKey);
    selectedImage.hidden = true;
    selectedStatus.textContent = "Preview unavailable. You can retry.";
    loadButton.textContent = "Retry neuron preview";
    loadButton.hidden = false;
  });
  const selectedText = document.createElement("div");
  const selectedCaption = document.createElement("figcaption");
  const selectedStatus = document.createElement("p");
  selectedStatus.className = "neuron-selected-preview__status";
  selectedStatus.setAttribute("role", "status");
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "mini-button";
  loadButton.textContent = "Preview selected neuron";
  selectedText.append(selectedCaption, selectedStatus, loadButton);
  selectedPreview.append(selectedImage, selectedText);

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
  note.textContent =
    "InceptionV3 · Each preview is an example that activates its channel. Select a card to use that Dream target.";
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
        : `${status.count} saved · up to ${status.limit}, reused after reload`;
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
  dialog.append(header, note, toolbar, cacheControls, grid, navigation);
  document.body.append(dialog);

  function showSelected(url) {
    selectedImage.src = url;
    selectedImage.alt = `Feature visualization · ${selectedCaption.textContent}`;
    selectedImage.hidden = false;
    selectedStatus.textContent =
      "An example feature response; live results depend on the field.";
    loadButton.hidden = true;
    selectedPreview.setAttribute("aria-busy", "false");
  }

  async function loadSelected(retry = false) {
    clearTimeout(timer);
    selectedAbort?.abort();
    const abort = new AbortController();
    selectedAbort = abort;
    const key = selectedKey;
    selectedStatus.textContent = "Generating feature preview…";
    selectedPreview.setAttribute("aria-busy", "true");
    loadButton.hidden = true;
    try {
      const url = await previewBridge.requestPreview(
        values.targetLayer,
        values.targetChannel,
        {
          signal: abort.signal,
          retry,
          onProgress: (step, total) => {
            if (!disposed && !abort.signal.aborted && key === selectedKey)
              selectedStatus.textContent = `Generating feature preview · ${Math.round((100 * step) / total)}%`;
          },
        },
      );
      if (!disposed && !abort.signal.aborted && key === selectedKey)
        showSelected(url);
    } catch (error) {
      if (disposed || abort.signal.aborted || key !== selectedKey) return;
      selectedStatus.textContent = "Preview unavailable. You can retry.";
      selectedPreview.setAttribute("aria-busy", "false");
      loadButton.textContent = "Retry neuron preview";
      loadButton.hidden = false;
    }
  }

  function update(parameters, { requestPreview = false } = {}) {
    values = parameters;
    const key = previewKey(values.targetLayer, values.targetChannel);
    const changed = selectedKey !== "" && selectedKey !== key;
    if (selectedKey !== key) {
      selectedAbort?.abort();
      clearTimeout(timer);
      selectedKey = key;
      selectedImage.hidden = true;
      selectedImage.removeAttribute("src");
      selectedCaption.textContent = `${values.targetLayer} · ${channelName(values.targetChannel)}`;
      selectedStatus.textContent =
        "See an example of what this channel responds to.";
      selectedPreview.setAttribute("aria-busy", "false");
      loadButton.textContent = "Preview selected neuron";
      loadButton.hidden = false;
    }
    const cached = previewBridge?.previewCache.get(key);
    if (cached) showSelected(cached);
    else if (changed || requestPreview) {
      selectedStatus.textContent = "Preparing feature preview…";
      timer = setTimeout(() => {
        void loadSelected();
      }, 250);
    }
    for (const { card, layer, channel } of visibleCards)
      card.setAttribute(
        "aria-pressed",
        String(
          layer === values.targetLayer && channel === values.targetChannel,
        ),
      );
  }

  function renderPage() {
    pageAbort?.abort();
    pageAbort = new AbortController();
    const signal = pageAbort.signal;
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
          previewBridge?.previewCache.has(previewKey(layer, channel)),
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
    const pages = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    range.textContent = choices.length
      ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, choices.length)} of ${choices.length} choices`
      : "No matching channels";
    visibleCards = [];
    grid.replaceChildren();
    if (!choices.length) {
      const empty = document.createElement("p");
      empty.className = "neuron-explorer__empty";
      empty.textContent =
        "No matching previews. Choose All channels to generate a new one.";
      grid.append(empty);
    }
    let previousGroup = "";
    for (const { layer, channel } of choices.slice(
      page * PAGE_SIZE,
      (page + 1) * PAGE_SIZE,
    )) {
      const group = layer.startsWith("mixed_5")
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
      status.textContent = "Queued preview…";
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
      card.addEventListener("click", () => {
        dialog.close();
        onSelect({
          layer,
          channel,
          name: `${layer} · ${channelName(channel)}`,
        });
        if (!disposed) void loadSelected(true);
      });
      visibleCards.push({ card, image, key, layer, channel });
      grid.append(card);
      const cached = previewBridge?.previewCache.get(key);
      if (cached) {
        image.src = cached;
        image.hidden = false;
        status.textContent = "";
      } else {
        previewBridge
          ?.requestPreview(layer, channel, {
            signal,
            priority: false,
            onProgress: (step, total) => {
              if (!signal.aborted)
                status.textContent = `Generating · ${Math.round((100 * step) / total)}%`;
            },
          })
          .then((url) => {
            if (disposed || signal.aborted) return;
            image.src = url;
            image.hidden = false;
            status.textContent = "";
          })
          .catch(() => {
            if (!signal.aborted)
              status.textContent = "Preview unavailable · select to retry";
          });
      }
    }
  }

  async function open() {
    if (dialog.open || disposed) return;
    layerSelect.value = "all";
    allLayers.disabled = false;
    collection.value = "available";
    search.value = "";
    page = 0;
    dialog.showModal();
    await previewBridge?.loadPreviews?.();
    if (disposed || !dialog.open) return;
    renderPage();
    grid
      .querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest" });
    layerSelect.focus();
  }
  loadButton.addEventListener("click", () => {
    void loadSelected(true);
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    clearTimeout(searchTimer);
    pageAbort?.abort();
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
    if (!disposed && key === selectedKey) showSelected(url);
  });
  update(parameters);
  return {
    selectedPreview,
    open,
    update,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(searchTimer);
      selectedAbort?.abort();
      pageAbort?.abort();
      unsubscribe?.();
      unsubscribeStorage?.();
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
