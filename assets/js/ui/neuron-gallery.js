// Reuse the pattern cards; previews come from the shared Inception model.
import { createNeuronExplorer } from "./neuron-explorer.js";

export function createNeuronGallery({
  neurons,
  parameters,
  onSelect,
  onSensorSelect,
  previewBridge,
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

  const actions = document.createElement("div");
  actions.className = "neuron-gallery__actions";
  actions.append(browse);

  section.append(title, note, actions);

  function update(values, options) {
    explorer.update(values, options);
  }
  update(parameters);
  void previewBridge?.loadPreviews?.();
  return {
    element: section,
    open: explorer.open,
    update,
    dispose() {
      explorer.dispose();
    },
  };
}
