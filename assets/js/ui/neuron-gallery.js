// Reuse the pattern cards; previews come from the shared Inception model.
export function createNeuronGallery({
  neurons,
  parameters,
  onSelect,
  onToggleManual,
  manualOpen,
  previewBridge,
}) {
  const section = document.createElement("section");
  section.className = "neuron-gallery";
  section.setAttribute("aria-label", "Neuron Archetype Gallery");
  const title = document.createElement("h3");
  title.textContent = "Neuron archetypes";
  const note = document.createElement("p");
  note.className = "neuron-gallery__note";
  note.append(
    "Suggested visual starting points; channel results vary. Previews appear after Inception loads. ",
  );
  const source = document.createElement("a");
  source.href = "https://distill.pub/2017/feature-visualization/";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.textContent = "Feature Visualization ↗";
  note.append(source);
  const strip = document.createElement("div");
  strip.className = "growth-gallery__grid neuron-gallery__strip";
  const cards = neurons.map((neuron) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "growth-gallery__card neuron-gallery__card";
    card.dataset.neuronId = neuron.id;
    const preview = document.createElement("span");
    preview.className = "growth-gallery__thumb-wrapper neuron-gallery__preview";
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
  section.append(title, note, strip, toggle);

  function setPreview(key, url) {
    for (const { neuron, image } of cards) {
      if (`${neuron.layer}_${neuron.channel}` !== key) continue;
      image.src = url;
      image.hidden = false;
    }
  }
  for (const [key, url] of previewBridge?.previewCache || [])
    setPreview(key, url);
  const unsubscribe = previewBridge?.subscribePreviews(setPreview);

  function update(values) {
    for (const { card, neuron } of cards) {
      const selected =
        values.targetLayer === neuron.layer &&
        values.targetChannel === neuron.channel &&
        Math.abs(values.dreamStrength - neuron.strength) < 1e-6;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", String(selected));
    }
  }
  update(parameters);
  return { element: section, update, dispose: () => unsubscribe?.() };
}
