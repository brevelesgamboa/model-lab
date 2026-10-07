import { terminal } from "../ui/terminal.js";
import { createSpatialMaskController } from "./spatial-mask-controller.js";

export function createDreamController({
  elements,
  controlElements,
  getModel,
  render,
  setAnimation,
  setStatus,
  withExclusiveCompute,
  onParameterChange,
}) {
  const isActive = () => getModel()?.id === "inception-dream";
  const spatialMaskController = createSpatialMaskController({
    elements,
    controlElements,
    getModel,
    setStatus,
    onParameterChange,
  });

  function update() {
    const active = isActive();
    elements.neuralDreamTools.hidden = !active;
    spatialMaskController.updateToolbarState();
    if (!active) return;
    const model = getModel();
    model.onStateChange = update;
    const stepBadge = model.totalSteps > 0 ? ` [STEPS: ${model.totalSteps}]` : "";
    const rawStatus = model.loadError || model.progressStatus || model.state;
    elements.neuralDreamStatus.textContent =
      rawStatus.includes("STEPS:") || rawStatus.includes("TOTAL:")
        ? rawStatus
        : `${rawStatus}${stepBadge}`;
    elements.neuralDreamStatus.title = model.loadError || model.sourceName;
    const processing = Boolean(model.isOctaveRunning || model.isRunning);
    elements.renderState.classList.toggle("is-processing", processing);
    if (model.loadError) elements.renderState.textContent = "MODEL ERROR";
    else if (processing) elements.renderState.textContent = "FEATURE ASCENT";
    else if (model.isPaused) elements.renderState.textContent = "ASCENT PAUSED";
    else if (model.octaveDone)
      elements.renderState.textContent = `FEATURE MAP READY (${model.totalSteps} STEPS)`;
    elements.loadNeuralDream.disabled =
      model.ready || Boolean(model.modelPromise);
    elements.loadNeuralDream.textContent = model.ready
      ? "MODEL READY"
      : model.modelPromise
        ? "LOADING MODEL"
        : "LOAD MODEL";
    elements.resetNeuralDream.disabled = !model.sourceLoaded || processing;
    elements.neuralDreamModeButtons.forEach((button) => {
      const mode = button.dataset.dreamMode;
      button.disabled =
        !model.sourceLoaded || (mode !== "original" && !model.ready);
      button.classList.toggle("mini-button--active", mode === model.mode);
      button.setAttribute("aria-pressed", String(mode === model.mode));
      if (mode === "dream") {
        button.textContent =
          model.totalSteps > 0 && model.octaveDone
            ? "+15 STEPS"
            : "RUN";
      }
    });

    if (elements.pauseNeuralDream) {
      elements.pauseNeuralDream.disabled =
        !model.sourceLoaded || !model.ready || (!processing && !model.isPaused);
      elements.pauseNeuralDream.textContent = model.isPaused ? "RESUME" : "PAUSE";
      elements.pauseNeuralDream.classList.toggle(
        "mini-button--active",
        Boolean(model.isPaused),
      );
      elements.pauseNeuralDream.setAttribute(
        "aria-pressed",
        String(Boolean(model.isPaused)),
      );
    }

    if (elements.moreNeuralDream) {
      elements.moreNeuralDream.disabled =
        !model.sourceLoaded || !model.ready || processing;
    }
  }

  async function sourceChanged() {
    const file = elements.neuralDreamImage.files?.[0];
    elements.neuralDreamImage.value = "";
    if (!file || !isActive()) return;
    const model = getModel();
    try {
      await model.setSourceFile(file);
      if (model !== getModel()) return;
      await render({ forceAnalysis: true });
      terminal("SOURCE", `${model.sourceName} loaded locally`);
      setStatus("SOURCE IMAGE READY");
    } catch (error) {
      if (model === getModel())
        setStatus(`IMAGE LOAD FAILED: ${error.message}`);
    } finally {
      update();
    }
  }

  async function loadModel() {
    if (!isActive()) return;
    const model = getModel();
    elements.loadNeuralDream.disabled = true;
    try {
      await withExclusiveCompute(() =>
        model.ensureModel((message) => {
          if (model === getModel())
            elements.neuralDreamStatus.textContent = message;
        }),
      );
      if (model !== getModel()) return;
      await render({ forceAnalysis: true });
      terminal("MODEL", `${model.name} ready`);
      setStatus("INCEPTIONV3 READY");
    } catch (error) {
      if (model === getModel()) {
        terminal("MODEL", error.message, "warning");
        setStatus("MODEL LOAD FAILED");
      }
    } finally {
      update();
    }
  }

  async function setMode(mode) {
    if (!isActive()) return;
    const model = getModel();
    if (!model.sourceLoaded || (mode !== "original" && !model.ready)) return;
    model.setMode(mode);
    if (mode !== "original") {
      setAnimation(true, { log: false });
      if (model.octaveDone && !model.isOctaveRunning) {
        setStatus(`CONTINUING SYNTHESIS (+15 STEPS · CURRENT: ${model.totalSteps})`);
        void model.dreamMore(15).finally(() => {
          setAnimation(false, { log: false });
          update();
        });
      }
    }
    await render({ forceAnalysis: true });
    update();
  }

  async function togglePause() {
    if (!isActive()) return;
    const model = getModel();
    if (!model.sourceLoaded || !model.ready) return;
    if (model.isOctaveRunning || model.isRunning) {
      model.pause();
      setStatus("SYNTHESIS PAUSED");
    } else if (model.isPaused) {
      model.resume();
      setAnimation(true, { log: false });
      await render({ forceAnalysis: true });
      setStatus("SYNTHESIS RESUMED");
    }
    update();
  }

  async function dreamMore() {
    if (!isActive()) return;
    const model = getModel();
    if (!model.sourceLoaded || !model.ready || model.isOctaveRunning) return;
    setAnimation(true, { log: false });
    setStatus(`CONTINUING SYNTHESIS (+15 STEPS · CURRENT: ${model.totalSteps})`);
    try {
      await model.dreamMore(15);
    } finally {
      setAnimation(false, { log: false });
    }
    await render({ forceAnalysis: true });
    update();
  }

  async function reset() {
    if (!isActive() || !getModel().sourceLoaded) return;
    const model = getModel();
    await model.resetDream("userReset");
    if (model !== getModel()) return;
    await render({ forceAnalysis: true });
    update();
    setStatus("SYNTHESIS RESET TO SOURCE");
  }

  return {
    isActive,
    update,
    sourceChanged,
    loadModel,
    setMode,
    togglePause,
    dreamMore,
    reset,
    spatialMaskController,
  };
}
