// Reuse the pattern cards; previews come from the shared Inception model.
import { createNeuronExplorer } from "./neuron-explorer.js";
export function createNeuronGallery({
  neurons,
  parameters,
  onSelect,
  onSensorSelect,
  onToggleManual,
  manualOpen,
  previewBridge,
  showStrip = true,
}) {
  const section = document.createElement("section");
  section.className = "neuron-gallery";
  section.setAttribute("aria-label", "Neuron Archetype Gallery");
  const title = document.createElement("h3");
  title.textContent = "Neuron previews";
  const note = document.createElement("p");
  note.className = "neuron-gallery__note";
  note.append(
    "InceptionV3 feature previews and Dream targets. Curated names describe suggested appearances; trained growth patterns are in the Growth gallery. ",
  );
  const source = document.createElement("a");
  source.href = "https://distill.pub/2017/feature-visualization/";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.textContent = "Feature Visualization ↗";
  note.append(source);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "mini-button neuron-gallery__manual";
  toggle.textContent = "Manual Channel Explorer";
  toggle.setAttribute("aria-controls", "dream-channel-control");
  toggle.setAttribute("aria-expanded", String(manualOpen));
  toggle.addEventListener("click", () => {
    manualOpen = !manualOpen;
    toggle.setAttribute("aria-expanded", String(manualOpen));
    onToggleManual(manualOpen);
  });

  const explorer = createNeuronExplorer({
    parameters,
    neurons,
    previewBridge,
    onSelect,
    onSensorSelect,
  });
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "mini-button neuron-gallery__browse";
  browse.textContent = "Browse neuron previews";
  browse.addEventListener("click", explorer.open);

  let cards = [];
  let currentLayer = parameters?.targetLayer || "mixed_5b";
  let currentChannel = parameters?.targetChannel ?? 120;
  let thumb = null;
  let thumbPlaceholder = null;
  let targetBadge = null;
  let targetName = null;
  let targetDesc = null;

  if (showStrip) {
    const strip = document.createElement("div");
    strip.className = "growth-gallery__grid neuron-gallery__strip";
    cards = neurons.map((neuron) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "growth-gallery__card neuron-gallery__card";
      card.dataset.neuronId = neuron.id;
      const preview = document.createElement("span");
      preview.className =
        "growth-gallery__thumb-wrapper neuron-gallery__preview";
      const image = document.createElement("img");
      image.className = "growth-gallery__thumb";
      image.alt = `${neuron.name} generated feature preview`;
      image.width = image.height = 96;
      image.hidden = true;
      preview.append(image);
      const name = document.createElement("span");
      name.className = "growth-gallery__card-name";
      name.textContent = neuron.name;
      const description = document.createElement("span");
      description.className = "neuron-gallery__description";
      description.textContent = neuron.desc;
      const channel = document.createElement("span");
      channel.className = "growth-gallery__card-id";
      channel.textContent = `${neuron.layer} • ${neuron.channel < 0 ? "All channels" : `#${neuron.channel}`}`;
      card.append(preview, name, description, channel);
      card.addEventListener("click", () => onSelect(neuron));
      strip.append(card);
      return { card, neuron, image };
    });
    section.append(title, note, browse, strip, toggle);
  } else {
    const previewCard = document.createElement("div");
    previewCard.className = "neuron-gallery__preview-card";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "neuron-gallery__thumb-wrapper";
    thumb = document.createElement("img");
    thumb.className = "neuron-gallery__thumb";
    thumb.width = thumb.height = 72;
    thumb.alt = "Feature preview";
    thumb.hidden = true;
    thumbPlaceholder = document.createElement("div");
    thumbPlaceholder.className = "neuron-gallery__thumb-placeholder";
    thumbPlaceholder.textContent = "No preview";
    thumbWrap.append(thumb, thumbPlaceholder);

    const info = document.createElement("div");
    info.className = "neuron-gallery__target-info";
    const header = document.createElement("div");
    header.className = "neuron-gallery__target-header";
    targetBadge = document.createElement("span");
    targetBadge.className = "neuron-gallery__target-badge";
    targetName = document.createElement("strong");
    targetName.className = "neuron-gallery__target-name";
    header.append(targetBadge, targetName);

    targetDesc = document.createElement("p");
    targetDesc.className = "neuron-gallery__target-desc";

    const meta = document.createElement("div");
    meta.className = "neuron-gallery__target-meta";
    const statusText = document.createElement("span");
    statusText.className = "neuron-gallery__preview-status";
    statusText.textContent = "Active relief & dream target";
    meta.append(statusText);

    info.append(header, targetDesc, meta);
    previewCard.append(thumbWrap, info);

    const actions = document.createElement("div");
    actions.className = "neuron-gallery__actions";
    actions.append(browse, toggle);
    section.append(previewCard, actions);
  }

  function updatePreview(layer, ch) {
    if (!thumb || !thumbPlaceholder) return;
    const key = `${layer}_${ch}`;
    const cached = previewBridge?.previewCache?.get(key);
    if (cached) {
      thumb.src = cached;
      thumb.hidden = false;
      thumbPlaceholder.hidden = true;
    } else {
      thumb.hidden = true;
      thumb.removeAttribute("src");
      thumbPlaceholder.hidden = false;
    }
  }

  function setPreview(key, url) {
    if (showStrip) {
      for (const { neuron, image } of cards) {
        if (`${neuron.layer}_${neuron.channel}` !== key) continue;
        image.src = url;
        image.hidden = false;
      }
    } else if (thumb && `${currentLayer}_${currentChannel}` === key) {
      thumb.src = url;
      thumb.hidden = false;
      if (thumbPlaceholder) thumbPlaceholder.hidden = true;
    }
  }
  for (const [key, url] of previewBridge?.previewCache || [])
    setPreview(key, url);
  const unsubscribe = previewBridge?.subscribePreviews(setPreview);

  function update(values, options) {
    explorer.update(values, options);
    currentLayer = values.targetLayer;
    currentChannel = values.targetChannel < 0 ? 0 : values.targetChannel;
    if (showStrip) {
      for (const { card, neuron } of cards) {
        const selected =
          values.targetLayer === neuron.layer &&
          values.targetChannel === neuron.channel &&
          Math.abs(values.dreamStrength - neuron.strength) < 1e-6;
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));
      }
    } else {
      updatePreview(currentLayer, currentChannel);
      if (targetBadge && targetName && targetDesc) {
        const matched = neurons.find(
          (n) =>
            n.layer === currentLayer &&
            (n.channel === currentChannel ||
              (n.channel < 0 && currentChannel === 0)),
        );
        targetBadge.textContent = `${currentLayer} · #${currentChannel}`;
        targetName.textContent = matched
          ? matched.name
          : `Custom Channel #${currentChannel}`;
        targetDesc.textContent = matched
          ? matched.desc
          : "Custom neuron target for 3D photo relief and full-dome synthesis";
      }
    }
  }
  update(parameters);
  void previewBridge?.loadPreviews?.();
  return {
    element: section,
    selectedPreview: explorer.selectedPreview,
    open: explorer.open,
    update,
    dispose() {
      unsubscribe?.();
      explorer.dispose();
    },
  };
}
