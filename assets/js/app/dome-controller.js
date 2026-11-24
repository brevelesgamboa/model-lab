import {
  createDomeOutpaintingControls,
  createDomeNcaControls,
} from "../ui/dome-controls.js";
import { createLocalModelCacheControls } from "../ui/local-model-cache.js";
import { terminal } from "../ui/terminal.js";

export function createDomeController({
  elements,
  getModel,
  model,
  render,
  canInteract,
  onParameterChange,
  openGrowthGallery,
}) {
  let gesture = null;
  let cacheKey = null;
  let lastLoggedPipeline = null;
  const cache = createLocalModelCacheControls(elements);
  const isActive = () => getModel() === model;
  const outpainting = createDomeOutpaintingControls(
    elements,
    model,
    isActive,
    canInteract,
  );
  const ncaControls = createDomeNcaControls(
    elements,
    model,
    isActive,
    canInteract,
    onParameterChange,
    { openGrowthGallery },
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
    elements.canvas.classList.remove("is-panning");
  }
  function stopDrift() {
    if (model.autonomousDrift) {
      model.setAutonomousDrift?.(false);
      if (elements.domeDriftToggle) {
        elements.domeDriftToggle.checked = false;
      }
    }
  }
  function update() {
    const active = isActive();
    outpainting.update();
    ncaControls.update();
    if (elements.domeDriftToggle) {
      elements.domeDriftToggle.checked = Boolean(model.autonomousDrift);
    }
    elements.domeTools.hidden = !active;
    elements.canvas.classList.toggle("has-dome-camera", active);
    if (active) elements.canvas.setAttribute("tabindex", "0");
    else elements.canvas.removeAttribute("tabindex");
    if (!active) {
      endGesture();
      return;
    }
    const fullPipeline = `${model.sourceName} · ${model.depthStatus} · ${model.featureStatus}`;
    if (fullPipeline !== lastLoggedPipeline) {
      lastLoggedPipeline = fullPipeline;
      terminal("DOME", fullPipeline, "info");
    }
    const sheenBlock = elements.parameterControls?.querySelector(
      '.control-block[data-parameter="ncaSheen"]',
    );
    if (sheenBlock) {
      sheenBlock.hidden = true;
      sheenBlock.style.display = "none";
      const dupInput = sheenBlock.querySelector("input, select");
      if (dupInput) {
        dupInput.removeAttribute("aria-label");
        dupInput.setAttribute("aria-hidden", "true");
        dupInput.tabIndex = -1;
      }
    }
    const nextKey = `${model.depthState}:${model.featureState}`;
    if (nextKey !== cacheKey) {
      cacheKey = nextKey;
      void cache.refresh();
    }
    elements.domeRetry.hidden =
      !model.hasPhoto ||
      ![model.depthState, model.featureState].includes("fallback");
    elements.domeRetry.disabled = [
      model.depthState,
      model.featureState,
    ].includes("loading");
    elements.domeResetView.disabled = false;
  }
  model.onStateChange = () => {
    update();
    redraw();
  };
  const report = (error) => {
    if (isActive() && error.name !== "AbortError")
      terminal(
        "DOME",
        `Could not prepare the photo: ${error.message}`,
        "error",
      );
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
  elements.domeDriftToggle?.addEventListener("change", () => {
    if (!isActive()) return;
    const enabled = elements.domeDriftToggle.checked;
    model.setAutonomousDrift?.(enabled);
    redraw();
  });
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (
      !isActive() ||
      !canInteract() ||
      ![0, 1, 2].includes(event.button)
    )
      return;
    stopDrift();
    event.preventDefault();
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: event.button !== 0,
    };
    elements.canvas.focus({ preventScroll: true });
    try {
      elements.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* Synthetic or untracked pointer ID */
    }
    elements.canvas.classList.add(gesture.pan ? "is-panning" : "is-looking");
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
    if (gesture.pan) {
      model.camera.pan(dx, dy, elements.canvas.clientHeight || 512);
    } else {
      model.camera.look(dx, dy);
    }
    redraw();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    elements.canvas.addEventListener(name, endGesture);
  elements.canvas.addEventListener(
    "wheel",
    (event) => {
      if (!isActive() || !canInteract()) return;
      stopDrift();
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
  elements.canvas.addEventListener("keydown", (event) => {
    if (!isActive() || !canInteract()) return;
    const direction = {
      ArrowLeft: [12, 0],
      ArrowRight: [-12, 0],
      ArrowUp: [0, 12],
      ArrowDown: [0, -12],
    }[event.key];
    if (!direction) return;
    stopDrift();
    event.preventDefault();
    model.camera.look(...direction);
    redraw();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) endGesture();
  });
  function onAudioFrame(levels, timestamp, rhythmController = null) {
    if (!isActive() || !levels) return;
    model.onAudioFrame?.(levels, timestamp, rhythmController);
  }
  return { update, onAudioFrame, stopDrift };
}
