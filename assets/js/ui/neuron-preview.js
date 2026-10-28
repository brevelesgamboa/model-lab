// Shared by Dream targets and the forward-only visual sensor. Loading a cached
// image is automatic; optimizing a new feature example always needs a click.
export function createNeuronPreview({
  parameters,
  previewBridge,
  className = "neuron-selected-preview",
  description = "An optimized feature example; live results depend on the field.",
}) {
  let values = parameters;
  let key = "";
  let abort = null;
  let disposed = false;
  const element = document.createElement("figure");
  element.className = className;
  element.setAttribute("aria-label", "Selected neuron preview");
  const image = document.createElement("img");
  image.width = image.height = 128;
  image.hidden = true;
  const text = document.createElement("div");
  const caption = document.createElement("figcaption");
  const status = document.createElement("p");
  status.className = "neuron-selected-preview__status";
  status.setAttribute("role", "status");
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "mini-button";
  text.append(caption, status, generate);
  element.append(image, text);

  function show(url) {
    if (image.getAttribute("src") !== url) image.src = url;
    image.alt = `Feature visualization · ${caption.textContent}`;
    image.hidden = false;
    status.textContent = description;
    generate.hidden = true;
    element.setAttribute("aria-busy", "false");
  }

  function unavailable() {
    image.hidden = true;
    image.removeAttribute("src");
    status.textContent = "Preview unavailable. You can retry.";
    generate.textContent = "Retry neuron preview";
    generate.hidden = false;
    element.setAttribute("aria-busy", "false");
  }
  image.addEventListener("error", () => {
    if (disposed || image.hidden) return;
    previewBridge?.previewCache.delete(key);
    unavailable();
  });

  function update(parameters) {
    values = parameters;
    const next = `${values.targetLayer}_${values.targetChannel}`;
    if (next !== key) {
      abort?.abort();
      key = next;
      image.hidden = true;
      image.removeAttribute("src");
      caption.textContent = `${values.targetLayer} · ${values.targetChannel < 0 ? "All channels" : `Channel #${values.targetChannel}`}`;
      status.textContent =
        "Click Preview selected neuron to generate an example.";
      element.setAttribute("aria-busy", "false");
      generate.textContent = "Preview selected neuron";
      generate.hidden = false;
    }
    const cached = previewBridge?.previewCache.get(key);
    if (cached && image.getAttribute("src") !== cached) show(cached);
  }

  generate.addEventListener("click", async () => {
    abort?.abort();
    const request = new AbortController();
    abort = request;
    const requestedKey = key;
    status.textContent = "Generating feature preview…";
    element.setAttribute("aria-busy", "true");
    generate.hidden = true;
    try {
      const url = await previewBridge.requestPreview(
        values.targetLayer,
        values.targetChannel,
        {
          signal: request.signal,
          retry: true,
          onProgress: (step, total) => {
            if (!disposed && !request.signal.aborted && key === requestedKey)
              status.textContent = `Generating feature preview · ${Math.round((100 * step) / total)}%`;
          },
        },
      );
      if (!disposed && !request.signal.aborted && key === requestedKey)
        show(url);
    } catch {
      if (!disposed && !request.signal.aborted && key === requestedKey)
        unavailable();
    }
  });
  const unsubscribe = previewBridge?.subscribePreviews((loadedKey, url) => {
    if (!disposed && loadedKey === key) show(url);
  });
  update(parameters);
  return {
    element,
    update,
    dispose() {
      disposed = true;
      abort?.abort();
      unsubscribe?.();
    },
  };
}
