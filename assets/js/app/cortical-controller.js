export function createCorticalController({
  elements,
  getModel,
  model,
  render,
  canInteract,
}) {
  let gesture = null;
  const isActive = () => getModel() === model;
  function update() {
    const active = isActive();
    elements.corticalTools.hidden = !active;
    elements.canvas.classList.toggle("has-orbit-camera", active);
    if (!active) endGesture();
    if (!active) return;
    elements.corticalStatus.textContent = `${model.sourceName} · ${model.depthStatus}`;
    elements.corticalStatus.title = model.depthError || "";
    elements.corticalRetryDepth.hidden =
      !model.hasPhoto || model.depthState !== "fallback";
  }
  const redraw = () => {
    if (isActive()) void render();
  };
  model.onStateChange = () => {
    update();
    redraw();
  };
  async function sourceChanged() {
    const file = elements.corticalImage.files?.[0];
    elements.corticalImage.value = "";
    if (!file || !isActive() || !canInteract()) return;
    try {
      await model.setSourceFile(file);
    } catch (error) {
      if (isActive())
        elements.corticalStatus.textContent = `Photo could not be loaded: ${error.message}`;
    }
  }
  elements.corticalImage.addEventListener("change", sourceChanged);
  elements.corticalResetCamera.addEventListener("click", () => {
    if (isActive() && canInteract()) {
      model.camera.reset();
      redraw();
    }
  });
  elements.corticalDemo.addEventListener("click", () => {
    if (isActive() && canInteract()) model.useDemo();
  });
  elements.corticalRetryDepth.addEventListener("click", () => {
    if (isActive() && canInteract()) void model.retryDepth();
  });
  function endGesture() {
    if (gesture && elements.canvas.hasPointerCapture?.(gesture.id))
      elements.canvas.releasePointerCapture(gesture.id);
    gesture = null;
    elements.canvas.classList.remove("is-orbiting");
  }
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (!isActive() || !canInteract() || ![0, 1, 2].includes(event.button))
      return;
    event.preventDefault();
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: event.button !== 0 || event.shiftKey,
    };
    elements.canvas.setPointerCapture(event.pointerId);
    elements.canvas.classList.add("is-orbiting");
  });
  elements.canvas.addEventListener("pointermove", (event) => {
    if (
      !gesture ||
      event.pointerId !== gesture.id ||
      !isActive() ||
      !canInteract()
    )
      return;
    event.preventDefault();
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.pan)
      model.camera.pan(dx, dy, elements.canvas.getBoundingClientRect().height);
    else model.camera.orbit(dx, dy);
    redraw();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    elements.canvas.addEventListener(name, endGesture);
  elements.canvas.addEventListener(
    "wheel",
    (event) => {
      if (!isActive() || !canInteract()) return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? elements.canvas.clientHeight
            : 1;
      model.camera.zoom(event.deltaY * scale);
      redraw();
    },
    { passive: false },
  );
  elements.canvas.addEventListener("contextmenu", (event) => {
    if (isActive()) event.preventDefault();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) endGesture();
  });
  return { update };
}
