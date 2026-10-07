// Route-local interactions only. Playback remains owned by the app controller.
import { renderModelTechnicalInfo } from "./controls-controller.js";

export function createGrowthController({
  elements,
  getModel,
  getView,
  render,
  setAnimation,
  setStatus,
  withExclusiveCompute,
}) {
  let busy = false;
  let pointerId = null;
  let lastInfo = null;
  const listeners = [];
  const activeModel = () =>
    getView() === "lab" && getModel()?.id === "neural-growth"
      ? getModel()
      : null;

  function update() {
    const model = activeModel();
    elements.growthTools.hidden = !model;
    elements.canvas.classList.toggle("is-growth", Boolean(model));
    if (!model) return;
    if (model.technicalInfo !== lastInfo) {
      renderModelTechnicalInfo(elements, model);
      lastInfo = model.technicalInfo;
    }
    const stats = model.getStats();
    elements.growthStatus.textContent = model.lastError
      ? `${model.lastError} Use Restart to retry.`
      : model.state === "LOADING"
        ? "Loading pattern; retaining the current field…"
        : stats
          ? `${stats.size} × ${stats.size} · ${stats.steps} updates · click or drag to disturb`
          : "Initializing WebGL2 field…";
    elements.growthStatus.dataset.steps = String(stats?.steps || 0);
    elements.growthStatus.dataset.size = String(stats?.size || 0);
    elements.stepGrowth.disabled = busy || !model.ready;
    elements.disturbGrowth.disabled = busy || !model.ready;
    elements.restartGrowth.disabled = busy;
  }

  async function act(operation, { pause = false } = {}) {
    const model = activeModel();
    if (!model || busy) return;
    busy = true;
    if (pause) setAnimation(false);
    update();
    try {
      await withExclusiveCompute(() => {
        if (activeModel() === model) operation(model);
      });
      if (activeModel() === model) await render({ forceAnalysis: true });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      update();
    }
  }

  function disturbAt(event) {
    const model = activeModel();
    if (!model?.ready) return;
    const rect = elements.canvas.getBoundingClientRect();
    const side = Math.min(rect.width, rect.height);
    if (!side) return;
    const x = (event.clientX - rect.left - (rect.width - side) / 2) / side;
    const y = (event.clientY - rect.top - (rect.height - side) / 2) / side;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return;
    const size = model.simulationSize;
    // GPU grid row zero is at the bottom of the displayed field.
    act((current) =>
      current.disturb(Math.floor(x * size), size - 1 - Math.floor(y * size)),
    );
  }

  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  listen(elements.stepGrowth, "click", () =>
    act((model) => model.step(), { pause: true }),
  );
  listen(elements.restartGrowth, "click", () =>
    act((model) => model.restart()),
  );
  listen(elements.disturbGrowth, "click", () =>
    act((model) => {
      const center = Math.floor(model.simulationSize / 2);
      model.disturb(center, center);
    }),
  );
  listen(elements.canvas, "pointerdown", (event) => {
    if (!activeModel() || event.button !== 0) return;
    pointerId = event.pointerId;
    elements.canvas.setPointerCapture(pointerId);
    disturbAt(event);
  });
  listen(elements.canvas, "pointermove", (event) => {
    if (pointerId === event.pointerId && event.buttons === 1) disturbAt(event);
  });
  const release = () => {
    pointerId = null;
  };
  listen(elements.canvas, "pointerup", release);
  listen(elements.canvas, "pointercancel", release);
  listen(elements.canvas, "lostpointercapture", release);
  return { update, dispose: () => listeners.forEach((remove) => remove()) };
}
