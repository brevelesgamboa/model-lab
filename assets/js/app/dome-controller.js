export function createDomeController({
  elements,
  getModel,
  model,
  render,
  canInteract,
}) {
  let gesture = null;
  const isActive = () => getModel() === model;
  const redraw = () => {
    if (isActive()) void render();
  };
  function endGesture() {
    const previous = gesture;
    gesture = null;
    if (previous && elements.canvas.hasPointerCapture?.(previous.id))
      elements.canvas.releasePointerCapture(previous.id);
    elements.canvas.classList.remove("is-looking");
  }
  function update() {
    const active = isActive();
    elements.domeTools.hidden = !active;
    elements.canvas.classList.toggle("has-dome-camera", active);
    if (active) elements.canvas.setAttribute("tabindex", "0");
    else elements.canvas.removeAttribute("tabindex");
    if (!active) {
      endGesture();
      return;
    }
    elements.domeStatus.textContent = `${model.sourceName} · ${model.depthStatus} · ${model.featureStatus}`;
    elements.domeStatus.title = [model.depthError, model.featureError]
      .filter(Boolean)
      .join(" · ");
    elements.domeRetry.hidden =
      !model.hasPhoto ||
      ![model.depthState, model.featureState].includes("fallback");
    elements.domeRetry.disabled = [
      model.depthState,
      model.featureState,
    ].includes("loading");
  }
  model.onStateChange = () => {
    update();
    redraw();
  };
  const report = (error) => {
    if (isActive() && error.name !== "AbortError")
      elements.domeStatus.textContent = `Could not prepare the photo: ${error.message}`;
  };
  elements.domeImage.addEventListener("change", () => {
    const file = elements.domeImage.files?.[0];
    elements.domeImage.value = "";
    if (file && isActive() && canInteract())
      void model.setSourceFile(file).catch(report);
  });
  elements.domeResetView.addEventListener("click", () => {
    if (isActive() && canInteract()) {
      model.camera.reset();
      redraw();
    }
  });
  elements.domeDemo.addEventListener("click", () => {
    if (isActive() && canInteract()) model.useDemo();
  });
  elements.domeRetry.addEventListener("click", () => {
    if (isActive() && canInteract()) void model.retryMaps().catch(report);
  });
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (!isActive() || !canInteract() || event.button !== 0) return;
    event.preventDefault();
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    elements.canvas.focus({ preventScroll: true });
    elements.canvas.setPointerCapture(event.pointerId);
    elements.canvas.classList.add("is-looking");
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
    model.camera.look(event.clientX - gesture.x, event.clientY - gesture.y);
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    redraw();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    elements.canvas.addEventListener(name, endGesture);
  elements.canvas.addEventListener("keydown", (event) => {
    if (!isActive() || !canInteract()) return;
    const direction = {
      ArrowLeft: [12, 0],
      ArrowRight: [-12, 0],
      ArrowUp: [0, 12],
      ArrowDown: [0, -12],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    model.camera.look(...direction);
    redraw();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) endGesture();
  });
  return { update };
}
