import {
  createDomeOutpaintingControls,
  createDomeNeuronControls,
} from "../ui/dome-controls.js";
import { createLocalModelCacheControls } from "../ui/local-model-cache.js";

export function createDomeController({
  elements,
  getModel,
  model,
  render,
  canInteract,
  onParameterChange,
}) {
  let gesture = null;
  let cacheKey = null;
  const cache = createLocalModelCacheControls(elements);
  const isActive = () => getModel() === model;
  const outpainting = createDomeOutpaintingControls(
    elements,
    model,
    isActive,
    canInteract,
  );
  const neuronControls = createDomeNeuronControls(
    elements,
    model,
    isActive,
    canInteract,
    onParameterChange,
  );
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
    outpainting.update();
    neuronControls.update();
    elements.domeTools.hidden = !active;
    elements.domeBakeOverlay.hidden = !active || model.bakeState !== "baking";
    elements.canvas.classList.toggle("has-dome-camera", active);
    if (active) elements.canvas.setAttribute("tabindex", "0");
    else elements.canvas.removeAttribute("tabindex");
    if (!active) {
      endGesture();
      return;
    }
    if (model.bakeState === "baking") endGesture();
    elements.domeStatus.textContent = `${model.sourceName} · ${model.depthStatus} · ${model.featureStatus} · ${model.bakeStatus}`;
    const isMigan =
      model.outpaintingMode === "migan" ||
      ["loading", "missing"].includes(model.inpaintState);
    if (elements.dreamSynthesisSection) {
      elements.dreamSynthesisSection.hidden = isMigan;
      elements.dreamSynthesisSection.style.display = isMigan ? "none" : "block";
    }
    const targetBlock = elements.parameterControls?.querySelector(
      '.control-block[data-parameter="featureTarget"]',
    );
    if (targetBlock) {
      targetBlock.hidden = true;
      targetBlock.style.display = "none";
      const dupSelect = targetBlock.querySelector("select");
      if (dupSelect) {
        dupSelect.removeAttribute("aria-label");
        dupSelect.setAttribute("aria-hidden", "true");
        dupSelect.tabIndex = -1;
      }
    }
    elements.domeGenerate.hidden = isMigan;
    elements.domeGenerate.disabled =
      isMigan ||
      !model.hasPhoto ||
      model.bakeState === "baking" ||
      [model.depthState, model.featureState].includes("loading");
    elements.domeBakeLabel.textContent = model.bakeStatus;
    elements.domeBakeProgress.value = model.bakeProgress;
    const nextKey = `${model.depthState}:${model.featureState}:${model.bakeState}`;
    if (nextKey !== cacheKey) {
      cacheKey = nextKey;
      void cache.refresh();
    }
    elements.domeStatus.title = [
      model.depthError,
      model.featureError,
      model.bakeError,
    ]
      .filter(Boolean)
      .join(" · ");
    elements.domeRetry.hidden =
      !model.hasPhoto ||
      ![model.depthState, model.featureState].includes("fallback");
    elements.domeRetry.disabled = [
      model.depthState,
      model.featureState,
    ].includes("loading");
    elements.domeResetView.disabled = model.bakeState === "baking";
  }
  let lastSyncedTarget = null;
  model.onStateChange = () => {
    if (
      onParameterChange &&
      model.selectedTarget !== undefined &&
      model.selectedTarget !== lastSyncedTarget
    ) {
      lastSyncedTarget = model.selectedTarget;
      onParameterChange("featureTarget", model.selectedTarget);
    }
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
  elements.domeGenerate.addEventListener("click", () => {
    if (isActive() && canInteract()) void model.generateDream().catch(report);
  });
  elements.domeCancelBake.addEventListener("click", () => model.cancelDream());
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (
      !isActive() ||
      !canInteract() ||
      model.bakeState === "baking" ||
      event.button !== 0
    )
      return;
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
      model.bakeState === "baking" ||
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
    if (!isActive() || !canInteract() || model.bakeState === "baking") return;
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
