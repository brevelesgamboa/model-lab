import {
  defaultParameters,
  sanitizeParameters as sanitizedStoredParameters,
  supportsModulation,
  captureCapabilities,
} from "./core/model-contract.js";
import { createPlaybackController } from "./app/playback-controller.js";
import {
  createNavigationController,
  resolveView,
} from "./app/navigation-controller.js";
import { createRenderController } from "./app/render-controller.js";
import {
  createControlsController,
  renderModelTechnicalInfo,
  formatControlValue,
  precisionFromStep,
  coerceRangeValue,
} from "./app/controls-controller.js";
import { createDreamController } from "./app/dream-controller.js";
import { createGrowthController } from "./app/growth-controller.js";
import { createExportController } from "./capture/export-controller.js";
import { ModelRegistry } from "./core/model-registry.js";
import { ExperimentStore } from "./core/experiment-store.js";
import { analyzeCanvas } from "./core/canvas-metrics.js";
import {
  qualityOptions,
  resolveQuality,
  detectCapabilities,
} from "./core/quality.js";
import { rhythmController } from "./core/rhythm-controller.js";
import { terminal } from "./ui/terminal.js";
import { drawModulationVisualizer } from "./ui/modulation-visualizer.js";
import {
  makeModulationPanel as buildModulationPanel,
  modulationIsActive,
} from "./ui/modulation-panel.js";
import {
  updateAudioUi,
  toggleAudioInput,
  drawAudioMeter,
} from "./audio/monitor.js";
import { createStudioController } from "./studio/studio-controller.js";
import { collectElements } from "./app/dom-elements.js";
import {
  createArchiveController,
  formatArchiveTime,
} from "./archive/archive-controller.js";
import { createHqGallery } from "./capture/hq-gallery.js";
import {
  CLASSIC_FRACTAL_VIEWS,
  FRACTAL_EXPLORE_ROUTE_IDS,
  FRACTAL_PROCESS_COPY,
  FRACTAL_ROUTE_IDS,
  LEGACY_PANEL_STORAGE_KEY,
  LEGACY_QUALITY_STORAGE_KEY,
  LOOP_PRESETS,
  PANEL_STORAGE_KEY,
  QUALITY_STORAGE_KEY,
} from "./app/config.js";
import {
  applyAudioModulation,
  audioMatrixForModel,
  getAudioRoute,
  hasActiveAudioRoute,
  restoreAudioMatrix,
} from "./core/modulation-matrix.js";
import {
  LFO_WAVEFORMS,
  applyLfo,
  defaultLfoConfig,
  hasActiveLfo,
} from "./core/lfo.js";
import { clamp, deepClone, randomSeed } from "./core/utils.js";

const elements = collectElements();

const registry = new ModelRegistry();
const capabilities = detectCapabilities();
const modelParameterState = new Map();
const modelLfoState = new Map();
const controlElements = new Map();
let currentModel = registry.getDefault();
let currentParameters = {};
let currentLfoState = {};
let latestRender = null;
let animationEnabled = false;
let animationEpoch = performance.now();
let lastTimeSeconds = 0;
let lastRenderedAt = 0;
let lastAnalyzedAt = 0;
let frameCounter = 0;
let animationHandle = 0;
let gifEncoding = false;
let hqRendering = false;
let liveResolutionScale = 1;
let canvasGesture = null;
const touchPoints = new Map();
let loopPresetState = { id: "off", startedAt: 0, base: null };
let smoothedRenderMs = 12;
let fpsFrameCount = 0;
let reportedFps = 0;
let fpsWindowStartedAt = performance.now();
let lastLiveResizeAt = 0;
let lastControlUiAt = 0;
let currentView = "lab";
let panelVisibility = readPanelVisibility();
let qualityMode = readQualityMode();
let qualityProfile = resolveQuality(qualityMode, capabilities);

const renderer = createRenderController({
  getSnapshot({
    forceAnalysis = false,
    timeSeconds = lastTimeSeconds,
    advanceSimulation = false,
  } = {}) {
    if (
      !currentModel?.available ||
      currentView !== "lab" ||
      document.hidden ||
      playback.isSuspended() ||
      gifEncoding ||
      hqRendering
    )
      return null;
    return {
      model: currentModel,
      canvas: elements.canvas,
      parameters: effectiveParametersAt(timeSeconds),
      timeSeconds,
      forceAnalysis,
      advanceSimulation: advanceSimulation && playback.isActive(),
    };
  },
  onStart() {
    elements.renderState.textContent = "RENDERING";
    elements.renderState.classList.add("is-processing");
  },
  onFrame: acceptRenderedFrame,
  onError(error) {
    elements.renderState.textContent = "RENDER ERROR";
    elements.renderState.classList.remove("is-processing");
    terminal("RENDER", error.message, "warning");
    setStatus("RENDER ERROR");
  },
});
const playback = createPlaybackController({
  getModel: () => currentModel,
  getEnabled: () => animationEnabled,
  getView: () => currentView,
  isHidden: () => document.hidden || gifEncoding || hqRendering,
  onResume: () => {
    animationEpoch = performance.now() - lastTimeSeconds * 1000;
  },
});
const navigation = createNavigationController({
  elements,
  onNavigate(view) {
    if (currentView !== view) renderer.invalidate();
    currentView = view;
    playback.sync();
    if (view === "archive") archiveController.render();
    if (view === "experiments") studioController.refreshPanels();
    if (view === "lab") renderCurrentFrame({ forceAnalysis: true });
    setStatus(`${view.toUpperCase()} VIEW`);
  },
});
const withExclusiveCompute = (operation) =>
  playback.withExclusiveCompute(async () => {
    await renderer.waitForIdle();
    return operation();
  });
const dreamController = createDreamController({
  elements,
  controlElements,
  getModel: () => currentModel,
  render: renderCurrentFrame,
  setAnimation,
  setStatus,
  withExclusiveCompute,
  onParameterChange: (key, value) => {
    currentParameters[key] = value;
    modelParameterState.set(currentModel.id, deepClone(currentParameters));
    markPresetCustom();
  },
});
const growthController = createGrowthController({
  elements,
  getModel: () => currentModel,
  getView: () => currentView,
  render: renderCurrentFrame,
  setAnimation,
  setStatus,
  withExclusiveCompute,
});
const controlsController = createControlsController({
  elements,
  controlElements,
  getModel: () => currentModel,
  getParameters: () => currentParameters,
  getLfoState: () => currentLfoState,
  onPreset(preset) {
    applyParameterSet(
      { ...currentParameters, ...preset.parameters },
      { presetName: preset.name },
    );
    terminal("PRESET", `${preset.name} loaded`);
    setStatus(`${preset.name} PRESET LOADED`);
  },
  onRange: syncRangeControl,
  onValue(definition, value) {
    currentParameters[definition.key] = value;
    // Discard obsolete completion callbacks, without discarding GPU state.
    if (currentModel.onParameterChange?.(definition.key, value))
      renderer.invalidate();
    modelParameterState.set(currentModel.id, deepClone(currentParameters));
    markPresetCustom();
    invalidateCurrentRun("PARAMETERS CHANGED");
    if (definition.key === "spatialFocus") {
      dreamController.spatialMaskController?.onSpatialFocusSelect?.(value);
    }
    renderCurrentFrame({ forceAnalysis: true });
  },
  onInfo: showParameterInfo,
  makeModulationPanel,
  onModulationOpen: () =>
    requestAnimationFrame(() =>
      updateEffectiveControlReadouts(effectiveParametersAt(lastTimeSeconds)),
    ),
});

function acceptRenderedFrame({
  model,
  result,
  parameters,
  timeSeconds,
  forceAnalysis,
  renderMilliseconds,
}) {
  const now = performance.now();
  const activelyMoving = modelNeedsAnimation() || Boolean(model.isRunning);
  const interval = activelyMoving
    ? Math.max(1000, qualityProfile.analysisInterval)
    : qualityProfile.analysisInterval;
  const shouldAnalyze =
    forceAnalysis || !latestRender || now - lastAnalyzedAt >= interval;
  const commonMetrics = shouldAnalyze
    ? analyzeCanvas(elements.canvas)
    : latestRender.commonMetrics;
  if (shouldAnalyze) lastAnalyzedAt = now;
  latestRender = {
    backend: result?.backend || model.backend,
    modelMetrics: result?.modelMetrics || {},
    commonMetrics,
    metrics: {
      ...commonMetrics,
      inferenceMs: Number(result?.inferenceMs) || 0,
    },
    effectiveParameters: parameters,
    timeSeconds,
  };
  if (forceAnalysis || now - lastControlUiAt >= 100) {
    updateEffectiveControlReadouts(parameters, timeSeconds);
    lastControlUiAt = now;
  }
  updateLivePerformance(now, renderMilliseconds, parameters);
  frameCounter += 1;
  elements.frameIndex.textContent = String(frameCounter % 10000).padStart(
    4,
    "0",
  );
  const failed =
    result?.status === "error" || result?.modelMetrics?.modelState === "ERROR";
  const processing = Boolean(model.isRunning || model.isOctaveRunning);
  elements.renderState.textContent = failed
    ? "MODEL ERROR"
    : processing
      ? "FEATURE ASCENT"
      : result?.status === "waiting"
        ? model.state
        : activelyMoving && animationEnabled
          ? "LIVE"
          : "FRAME READY";
  elements.renderState.classList.toggle("is-processing", processing);
  elements.modelBackend.textContent = `BACKEND: ${latestRender.backend}`;
  dreamController.update();
  growthController.update();
  if (failed) setStatus(`${model.name} ERROR`);
  else if (
    ["LOADING", "CHECKING"].some(
      (state) =>
        elements.statusMessage.textContent ===
        `${model.name.toUpperCase()} ${state}`,
    )
  )
    setStatus(`${model.name} READY`);
  return latestRender;
}

const studioController = createStudioController({
  elements,
  registry,
  getCurrentModel: () => currentModel,
  defaultParameters,
  refreshModelOptions,
  selectModel,
  navigate,
  updateResourceStatus,
  setStatus,
  formatArchiveTime,
  withExclusiveCompute,
});

const archiveController = createArchiveController({
  elements,
  onRestore: restoreRun,
  onClear: () => invalidateCurrentRun(),
  setStatus,
});

const hqGallery = createHqGallery({
  elements,
  isRendering: () => hqRendering,
  setStatus,
});

const { savePng, saveGif } = createExportController({
  elements,
  capabilities,
  hqGallery,
  getState: () => ({
    model: currentModel,
    quality: qualityProfile,
    time: lastTimeSeconds,
    gifEncoding,
    hqRendering,
    pending: renderer.getPending(),
    loopPresetState,
  }),
  onBusyChange(type, active) {
    if (type === "gif") gifEncoding = active;
    else hqRendering = active;
    playback.sync();
  },
  renderCurrentFrame,
  effectiveParametersAt,
  selectedLoopPreset,
  updateFractalTools,
  setStatus,
});

function readPanelVisibility() {
  const fallback = { input: true, terminal: false };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PANEL_STORAGE_KEY) ||
        window.localStorage.getItem(LEGACY_PANEL_STORAGE_KEY) ||
        "null",
    );
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      input: parsed.input !== false,
      terminal: parsed.terminal === true,
    };
  } catch {
    return fallback;
  }
}

function savePanelVisibility() {
  try {
    window.localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify(panelVisibility),
    );
  } catch {
    // Layout still works when storage is blocked.
  }
}

function readQualityMode() {
  try {
    return (
      window.localStorage.getItem(QUALITY_STORAGE_KEY) ||
      window.localStorage.getItem(LEGACY_QUALITY_STORAGE_KEY) ||
      "auto"
    );
  } catch {
    return "auto";
  }
}

function saveQualityMode(mode) {
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, mode);
  } catch {
    // The app still works when storage is blocked.
  }
}

export function setStatus(message) {
  elements.statusMessage.textContent = String(message || "READY").toUpperCase();
}

function defaultLfoState(model) {
  return Object.fromEntries(
    model.controls
      .filter((definition) => supportsModulation(model, definition))
      .map((definition) => [definition.key, defaultLfoConfig()]),
  );
}

function sanitizedLfoState(model, stored) {
  const defaults = defaultLfoState(model);
  Object.keys(defaults).forEach((key) => {
    const candidate = stored?.[key];
    if (!candidate || typeof candidate !== "object") return;
    defaults[key] = {
      enabled: Boolean(candidate.enabled),
      waveform: LFO_WAVEFORMS.some(
        (entry) => entry.value === candidate.waveform,
      )
        ? candidate.waveform
        : "sine",
      rate: clamp(candidate.rate, 0.005, 8),
      depth: clamp(candidate.depth, 0, 1),
      phase: clamp(candidate.phase, 0, 1),
    };
  });
  return defaults;
}

function isFractalRoute(model = currentModel) {
  return FRACTAL_ROUTE_IDS.has(model?.id);
}

function supportsCanvasExploration(model = currentModel) {
  return FRACTAL_EXPLORE_ROUTE_IDS.has(model?.id);
}

function wrapUnit(value) {
  return ((Number(value) % 1) + 1) % 1;
}

function selectedLoopPreset() {
  return (
    LOOP_PRESETS.find((preset) => preset.id === loopPresetState.id) ||
    LOOP_PRESETS[0]
  );
}

function loopPhaseAt(timeSeconds) {
  const preset = selectedLoopPreset();
  if (!preset.duration) return 0;
  const elapsed = Number(timeSeconds) - Number(loopPresetState.startedAt || 0);
  return (((elapsed / preset.duration) % 1) + 1) % 1;
}

function applyLoopPreset(base, phase) {
  const output = { ...base };
  const wave = Math.sin(phase * Math.PI * 2);
  const waveQuarter = Math.cos(phase * Math.PI * 2);
  const presetId = loopPresetState.id;

  if (currentModel.id === "folded-fractal") {
    output.pulse = 0;
    output.grain = Math.min(Number(output.grain) || 0, 0.02);
    if (presetId === "orbit") {
      output.rotation = Number(base.rotation) + wave * 14;
      output.scale = Number(base.scale) + waveQuarter * 0.09;
      output.palette = wrapUnit(Number(base.palette) + phase);
    } else if (presetId === "pulse") {
      output.scale = Number(base.scale) + wave * 0.12;
      output.gain = Number(base.gain) + waveQuarter * 0.08;
    } else if (presetId === "color") {
      output.palette = wrapUnit(Number(base.palette) + phase);
    } else if (presetId === "echo") {
      output.rotation = Number(base.rotation) + wave * 9;
      output.ghosting = clamp(0.28 + waveQuarter * 0.16, 0, 0.5);
      output.palette = wrapUnit(Number(base.palette) + phase * 0.5);
    }
  }

  return sanitizedStoredParameters(currentModel, output);
}

function setLoopPreset(presetId, { log = true, render = true } = {}) {
  const preset =
    LOOP_PRESETS.find((entry) => entry.id === presetId) || LOOP_PRESETS[0];
  loopPresetState = {
    id: preset.id,
    startedAt: lastTimeSeconds,
    base: deepClone(currentParameters),
  };
  if (elements.loopPreset) {
    elements.loopPreset.value = preset.id;
  }
  if (preset.id !== "off") {
    setAnimation(true, { log: false });
  }
  if (render) renderCurrentFrame({ forceAnalysis: true });
  if (log)
    terminal(
      "LOOP",
      preset.id === "off"
        ? "loop preset stopped"
        : preset.name + " / " + preset.duration + " second seamless cycle",
    );
  setStatus(
    preset.id === "off" ? "LOOP PRESET OFF" : preset.name + " LOOP ACTIVE",
  );
}

function pointOnOutputCanvas(event) {
  const bounds = elements.canvas.getBoundingClientRect();
  return {
    x: clamp(Number(event.clientX) - bounds.left, 0, bounds.width),
    y: clamp(Number(event.clientY) - bounds.top, 0, bounds.height),
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
}

function updateFromCanvas(parameters, message) {
  applyParameterSet(parameters, { message });
}

function fractalCoordinateAt(point, parameters = currentParameters) {
  const zoom = 10 ** clamp(Number(parameters.zoomExponent), -0.2, 5.5);
  const aspect = point.width / point.height;
  return {
    x:
      Number(parameters.centerX) +
      (((point.x / point.width) * 2 - 1) * aspect) / zoom,
    y: Number(parameters.centerY) + ((point.y / point.height) * 2 - 1) / zoom,
  };
}

function moveExplorerTo(point, message = "VIEW MOVED - SAVE WHEN READY") {
  const location = fractalCoordinateAt(point);
  updateFromCanvas(
    { ...currentParameters, centerX: location.x, centerY: location.y },
    message,
  );
}

function panExplorer(dx, dy, point) {
  const zoom = 10 ** clamp(Number(currentParameters.zoomExponent), -0.2, 5.5);
  const aspect = point.width / point.height;
  updateFromCanvas(
    {
      ...currentParameters,
      centerX: clamp(
        Number(currentParameters.centerX) -
          ((dx / point.width) * 2 * aspect) / zoom,
        -2.5,
        1.5,
      ),
      centerY: clamp(
        Number(currentParameters.centerY) - ((dy / point.height) * 2) / zoom,
        -1.7,
        1.7,
      ),
    },
    "VIEW MOVED - SAVE WHEN READY",
  );
}

function zoomExplorerAt(point, multiplier) {
  const before = fractalCoordinateAt(point);
  const next = {
    ...currentParameters,
    zoomExponent: clamp(
      Number(currentParameters.zoomExponent) + Math.log10(multiplier),
      -0.2,
      5.5,
    ),
  };
  const after = fractalCoordinateAt(point, next);
  next.centerX = clamp(Number(next.centerX) + before.x - after.x, -2.5, 1.5);
  next.centerY = clamp(Number(next.centerY) + before.y - after.y, -1.7, 1.7);
  updateFromCanvas(next, "VIEW ZOOMED - SAVE WHEN READY");
}

function steerFractalField(dx, dy) {
  const next = { ...currentParameters };
  next.rotation = (((Number(next.rotation) + dx * 0.28) % 360) + 360) % 360;
  next.scale = clamp(Number(next.scale) - dy * 0.004, 0.8, 4);
  next.gain = clamp(Number(next.gain) + dx * 0.0008, 0.2, 1.6);
  updateFromCanvas(next, "FIELD STEERED - SAVE WHEN READY");
}

function finishCanvasGesture() {
  touchPoints.clear();
  canvasGesture = null;
  elements.canvas.classList.remove("is-exploring");
}

function startCanvasGesture(event) {
  if (!supportsCanvasExploration()) return;
  if (event.pointerType !== "touch" && event.button !== 0) return;
  event.preventDefault();
  const point = pointOnOutputCanvas(event);
  if (event.pointerType === "touch") touchPoints.set(event.pointerId, point);
  canvasGesture = {
    pointerId: event.pointerId,
    point,
    moved: false,
    pendingX: 0,
    pendingY: 0,
    lastUpdate: 0,
    pinchDistance: 0,
  };
  elements.canvas.setPointerCapture?.(event.pointerId);
  elements.canvas.classList.add("is-exploring");
}

function moveCanvasGesture(event) {
  if (!canvasGesture || !supportsCanvasExploration()) return;
  if (event.pointerType === "touch")
    touchPoints.set(event.pointerId, pointOnOutputCanvas(event));
  const point = pointOnOutputCanvas(event);
  const points = Array.from(touchPoints.values());
  if (
    event.pointerType === "touch" &&
    points.length > 1 &&
    currentModel.id === "fractal-functions"
  ) {
    event.preventDefault();
    const first = points[0];
    const second = points[1];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (canvasGesture.pinchDistance) {
      const multiplier = clamp(
        distance / canvasGesture.pinchDistance,
        0.78,
        1.28,
      );
      if (Math.abs(multiplier - 1) > 0.01) zoomExplorerAt(point, multiplier);
    }
    canvasGesture.moved = true;
    canvasGesture.pinchDistance = distance;
    return;
  }
  if (canvasGesture.pointerId !== event.pointerId) return;
  const dx = point.x - canvasGesture.point.x;
  const dy = point.y - canvasGesture.point.y;
  canvasGesture.point = point;
  canvasGesture.pendingX += dx;
  canvasGesture.pendingY += dy;
  if (Math.hypot(canvasGesture.pendingX, canvasGesture.pendingY) > 4) {
    canvasGesture.moved = true;
  }
  if (event.timeStamp - canvasGesture.lastUpdate < 28) return;
  if (!canvasGesture.moved) return;
  event.preventDefault();
  const pendingX = canvasGesture.pendingX;
  const pendingY = canvasGesture.pendingY;
  canvasGesture.pendingX = 0;
  canvasGesture.pendingY = 0;
  canvasGesture.lastUpdate = event.timeStamp;
  if (currentModel.id === "fractal-functions")
    panExplorer(pendingX, pendingY, point);
  else steerFractalField(pendingX, pendingY);
}

function endCanvasGesture(event) {
  if (!canvasGesture) return;
  if (event.pointerType === "touch") touchPoints.delete(event.pointerId);
  if (canvasGesture.pointerId === event.pointerId && !canvasGesture.moved) {
    if (currentModel.id === "fractal-functions")
      moveExplorerTo(pointOnOutputCanvas(event));
  }
  if (event.pointerType !== "touch" || touchPoints.size === 0)
    finishCanvasGesture();
}

function zoomCanvasWithWheel(event) {
  if (!supportsCanvasExploration() || currentModel.id !== "fractal-functions")
    return;
  event.preventDefault();
  const multiplier = event.deltaY < 0 ? 1.18 : 1 / 1.18;
  zoomExplorerAt(pointOnOutputCanvas(event), multiplier);
}

function baseParametersAt(timeSeconds) {
  if (selectedLoopPreset().duration && loopPresetState.base) {
    return applyLoopPreset(loopPresetState.base, loopPhaseAt(timeSeconds));
  }
  return { ...currentParameters };
}

function activeLfoCount() {
  return Object.values(currentLfoState || {}).filter(
    (config) => config?.enabled,
  ).length;
}

function updateLfoCount() {
  elements.lfoCount.textContent = String(activeLfoCount());
}

function effectiveParametersAt(timeSeconds, { loopPhase = null } = {}) {
  const output = {};
  const modulatedKeys = [];
  const modulationFrame = {};
  const audioLevels =
    rhythmController.status === "active" ? rhythmController.getLevels() : null;
  let baseParameters = baseParametersAt(timeSeconds);
  if (
    loopPhase !== null &&
    selectedLoopPreset().duration &&
    loopPresetState.base
  ) {
    baseParameters = applyLoopPreset(loopPresetState.base, loopPhase);
  }
  const loopActive = selectedLoopPreset().duration > 0;
  currentModel.controls.forEach((definition) => {
    const baseValue = baseParameters[definition.key];
    if (definition.type === "range") {
      const canModulate = supportsModulation(currentModel, definition);
      const lfoActive = Boolean(
        canModulate && currentLfoState[definition.key]?.enabled && !loopActive,
      );
      const oscillatorValue =
        loopActive || !canModulate
          ? baseValue
          : applyLfo(
              definition,
              baseValue,
              currentLfoState[definition.key],
              timeSeconds,
            );
      const audioRoute = canModulate
        ? getAudioRoute(currentModel.id, definition.key)
        : { source: "none", depth: 0 };
      const audioLevel =
        audioRoute.source === "none"
          ? 0
          : clamp(Number(audioLevels?.[audioRoute.source]) || 0, 0, 1);
      const kickLevel = clamp(Number(audioLevels?.kick) || 0, 0, 1);
      const effectiveValue = applyAudioModulation(
        definition,
        oscillatorValue,
        audioRoute,
        audioLevels,
      );
      const coercedEffectiveValue = coerceRangeValue(
        definition,
        effectiveValue,
      );
      output[definition.key] = coercedEffectiveValue;
      modulationFrame[definition.key] = {
        baseValue: Number(baseValue),
        oscillatorValue: Number(oscillatorValue),
        effectiveValue: Number(coercedEffectiveValue),
        audioSource: audioRoute.source,
        audioLevel,
        kickLevel,
        lfoActive,
      };
      if (
        currentLfoState[definition.key]?.enabled ||
        audioRoute.source !== "none"
      ) {
        modulatedKeys.push(definition.key);
      }
    } else {
      output[definition.key] = baseValue;
    }
  });
  Object.defineProperty(output, "__modulatedKeys", { value: modulatedKeys });
  Object.defineProperty(output, "__modulationFrame", {
    value: modulationFrame,
  });
  if (Number.isFinite(baseParameters.__seedB))
    output.__seedB = baseParameters.__seedB;
  if (Number.isFinite(baseParameters.__seedMix))
    output.__seedMix = baseParameters.__seedMix;
  return output;
}

function invalidateCurrentRun(message = "CURRENT FRAME NOT SAVED") {
  elements.runId.textContent = "UNSAVED";
  elements.captureStatus.textContent = message;
  elements.captureStatus.classList.remove("is-saved");
}

function syncRangeControl(definition, value, { render = true } = {}) {
  const control = controlElements.get(definition.key);
  const next = coerceRangeValue(definition, value);
  currentParameters[definition.key] = next;
  if (control) {
    control.slider.value = String(next);
    control.fine.value = String(next);
  }
  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  markPresetCustom();
  invalidateCurrentRun("PARAMETERS CHANGED - SAVE WHEN READY");
  if (
    currentModel.id === "inception-dream" &&
    [
      "spotlightRadius",
      "spotlightHardness",
      "wandTolerance",
      "wandRadius",
      "edgeSensitivity",
    ].includes(definition.key)
  ) {
    if (currentModel.spotlightState) {
      if (definition.key === "spotlightRadius")
        currentModel.spotlightState.radius = next;
      if (definition.key === "spotlightHardness") {
        currentModel.spotlightState.hardness = next;
        currentModel.spotlightState.feather = 1.0 - next;
      }
    }
    dreamController.spatialMaskController?.renderOverlay?.();
    dreamController.spatialMaskController?.renderContextualOptions?.();
  }
  if (render) renderCurrentFrame({ forceAnalysis: true });
}

function revealTerminalForLearning() {
  if (!panelVisibility.terminal) {
    panelVisibility.terminal = true;
    savePanelVisibility();
    applyPanelVisibility({ render: false });
  }
}

function showParameterInfo(definition) {
  revealTerminalForLearning();
  const info = definition.info || {};
  terminal("PARAMETER", definition.label);
  terminal(
    "PURPOSE",
    info.description ||
      definition.help ||
      `Controls ${definition.label.toLowerCase()} for the active model route.`,
  );
  if (definition.type === "range" || definition.type === "number") {
    terminal(
      "RANGE",
      `${definition.min} to ${definition.max}; normal step ${definition.step}; fine step ${definition.fineStep || definition.step}`,
    );
  } else if (definition.type === "select") {
    terminal(
      "OPTIONS",
      definition.options.map((entry) => entry.label).join(" / "),
    );
  }
  if (info.extremes) terminal("EXTREMES", info.extremes);
  if (supportsModulation(currentModel, definition)) {
    terminal(
      "MODULATION",
      info.lfo ||
        "Enable the LFO to oscillate around the base value. Depth controls travel, rate controls cycles per second, and phase offsets timing.",
    );
  }
  setStatus(`${definition.label} EXPLAINED IN SESSION LOG`);
}

function makeModulationPanel(definition, config, supportsLfo) {
  return buildModulationPanel({
    definition,
    config,
    supportsLfo,
    modelId: currentModel.id,
    getVisibleBase: () => controlElements.get(definition.key)?.fine?.value,
    coerceRangeValue,
    onCaptureBase(value) {
      currentParameters[definition.key] = value;
      modelParameterState.set(currentModel.id, deepClone(currentParameters));
    },
    onChange({ config: nextConfig, active }) {
      currentLfoState[definition.key] = nextConfig;
      modelLfoState.set(currentModel.id, deepClone(currentLfoState));
      markPresetCustom();
      invalidateCurrentRun("MODULATION CHANGED - SAVE WHEN READY");
      const control = controlElements.get(definition.key);
      control?.modulationToggle?.classList.toggle("is-active", active);
      control?.modulationToggle?.setAttribute("aria-pressed", String(active));
      updateLfoCount();
      if (active) setAnimation(true, { log: false });
      requestAnimationFrame(() =>
        updateEffectiveControlReadouts(effectiveParametersAt(lastTimeSeconds)),
      );
      renderCurrentFrame({ forceAnalysis: true });
    },
  });
}

function applyParameterSet(
  parameters,
  {
    render = true,
    message = "PARAMETERS CHANGED - SAVE WHEN READY",
    presetName = "",
  } = {},
) {
  currentParameters = sanitizedStoredParameters(currentModel, parameters);
  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  if (selectedLoopPreset().duration)
    loopPresetState.base = deepClone(currentParameters);

  currentModel.controls.forEach((definition) => {
    const control = controlElements.get(definition.key);
    const value = currentParameters[definition.key];
    if (!control) return;
    if (definition.type === "range") {
      control.slider.value = String(value);
      control.fine.value = String(value);
    } else if (definition.type === "select") {
      control.select.value = String(value);
    } else if (control.input) {
      control.input.value = String(value);
    }
    control.guidance?.update(value);
  });
  invalidateCurrentRun(message);
  controlsController.setPreset(presetName);
  if (render) renderCurrentFrame({ forceAnalysis: true });
}

function markPresetCustom() {
  controlsController.setPreset("");
  if (selectedLoopPreset().duration)
    loopPresetState.base = deepClone(currentParameters);
}

function initializeFractalToolOptions() {
  elements.classicFractalView.replaceChildren();
  const examplePlaceholder = document.createElement("option");
  examplePlaceholder.value = "";
  examplePlaceholder.textContent = "CHOOSE A VIEW";
  elements.classicFractalView.append(examplePlaceholder);
  CLASSIC_FRACTAL_VIEWS.forEach((view) => {
    const option = document.createElement("option");
    option.value = view.id;
    option.textContent = view.name;
    elements.classicFractalView.append(option);
  });
}

function applyClassicFractalView(viewId) {
  const view = CLASSIC_FRACTAL_VIEWS.find((entry) => entry.id === viewId);
  if (!view || currentModel.id !== "fractal-functions") return;
  applyParameterSet(
    { ...currentParameters, ...view.parameters },
    {
      message: view.name + " LOADED - SAVE WHEN READY",
    },
  );
  elements.classicFractalView.value = "";
  terminal("EXAMPLE", view.name + " loaded");
  setStatus(view.name + " LOADED");
}

function updateFractalTools() {
  const canExplore = supportsCanvasExploration();
  elements.fractalTools.hidden = !canExplore;
  elements.fractalExamplesTool.hidden = currentModel.id !== "fractal-functions";

  if (!canExplore) {
    loopPresetState = { id: "off", startedAt: lastTimeSeconds, base: null };
    return;
  }

  elements.exploreHint.textContent =
    currentModel.id === "fractal-functions"
      ? "CLICK OR DRAG TO MOVE · SCROLL OR PINCH TO ZOOM"
      : "DRAG TO STEER";
}

function isDreamRoute(model = currentModel) {
  return model?.id === "inception-dream";
}

function setFractalProcessStep(step) {
  const selected = Object.prototype.hasOwnProperty.call(
    FRACTAL_PROCESS_COPY,
    step,
  )
    ? step
    : "fold";
  elements.fractalProcess.dataset.step = selected;
  elements.fractalProcessCopy.textContent = FRACTAL_PROCESS_COPY[selected];
  elements.fractalProcessButtons.forEach((button) => {
    const active = button.dataset.fractalStep === selected;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderParameterControls() {
  controlsController.render();
  updateLfoCount();
  updateEffectiveControlReadouts(effectiveParametersAt(lastTimeSeconds));
}

function updateEffectiveControlReadouts(
  effectiveParameters,
  timeSeconds = lastTimeSeconds,
) {
  currentModel.controls.forEach((definition) => {
    if (definition.type !== "range") return;
    const control = controlElements.get(definition.key);
    if (!control?.effectiveLabel) return;
    const config = currentLfoState[definition.key] || defaultLfoConfig();
    const audioRoute = getAudioRoute(currentModel.id, definition.key);
    const effectiveValue = Number(effectiveParameters[definition.key]);
    const storedBaseValue = Number(currentParameters[definition.key]);
    const computedFrame =
      effectiveParameters.__modulationFrame?.[definition.key];
    const frame = computedFrame || {
      baseValue: storedBaseValue,
      oscillatorValue: applyLfo(
        definition,
        storedBaseValue,
        config,
        timeSeconds,
      ),
      effectiveValue,
      audioSource: audioRoute.source,
      audioLevel: 0,
      kickLevel: 0,
      lfoActive: Boolean(config.enabled),
    };
    const baseValue = Number(frame.baseValue);
    const comparisonStep = Math.max(
      1e-9,
      Number(definition.fineStep || definition.step || 0.001) * 0.25,
    );
    const active = modulationIsActive(config, audioRoute);
    const modulated = Boolean(
      active || Math.abs(effectiveValue - baseValue) > comparisonStep,
    );
    control.effectiveLabel.textContent = `${modulated ? "MOD" : "VALUE"} ${formatControlValue(definition, effectiveValue)}`;
    control.effectiveLabel.classList.toggle("is-active", modulated);
    control.modulationToggle?.classList.toggle("is-active", active);
    control.modulationToggle?.setAttribute("aria-pressed", String(active));

    const minimum = Number(definition.min);
    const maximum = Number(definition.max);
    const range = Math.max(1e-9, maximum - minimum);
    const basePosition = clamp((baseValue - minimum) / range, 0, 1) * 100;
    const effectivePosition =
      clamp((effectiveValue - minimum) / range, 0, 1) * 100;
    const lfoWidth = frame.lfoActive ? clamp(config.depth, 0, 1) * 50 : 0;
    const audioWidth =
      audioRoute.source !== "none"
        ? Math.abs(clamp(audioRoute.depth, -1, 1)) * 50
        : 0;
    const negativeWidth = lfoWidth + (audioRoute.depth < 0 ? audioWidth : 0);
    const positiveWidth = lfoWidth + (audioRoute.depth >= 0 ? audioWidth : 0);
    const left = clamp(basePosition - negativeWidth, 0, 100);
    const right = clamp(basePosition + positiveWidth, 0, 100);
    control.baseMarker.style.left = `${basePosition}%`;
    control.effectiveMarker.style.left = `${effectivePosition}%`;
    control.modulationRange.style.left = `${left}%`;
    control.modulationRange.style.width = `${Math.max(0, right - left)}%`;
    control.modulationRange.style.opacity = active ? "1" : "0";
    drawModulationVisualizer(
      definition,
      control.modulationVisualizer,
      frame,
      formatControlValue,
    );
  });
}

function refreshModelOptions(preferredId = currentModel?.id) {
  elements.modelSelect.replaceChildren();
  registry.getAll().forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.available
      ? model.name
      : `${model.name} [BUILD IN EXPERIMENTS]`;
    option.disabled = !model.available;
    elements.modelSelect.append(option);
  });
  const preferred = registry.get(preferredId);
  const selected = preferred?.available ? preferred : registry.getDefault();
  if (selected) elements.modelSelect.value = selected.id;
}

function selectModel(modelId, { log = true, preserveTime = false } = {}) {
  if (gifEncoding || hqRendering || playback.isSuspended()) {
    setStatus("WAIT FOR THE CURRENT COMPUTATION");
    return false;
  }
  const nextModel = registry.get(modelId);
  if (!nextModel || !nextModel.available) {
    navigate("experiments");
    setStatus("BUILD OR IMPORT A LOCAL MODEL IN EXPERIMENTS");
    return false;
  }

  loopPresetState = { id: "off", startedAt: lastTimeSeconds, base: null };

  if (currentModel) {
    currentModel.cancel?.();
    modelParameterState.set(currentModel.id, deepClone(currentParameters));
    modelLfoState.set(currentModel.id, deepClone(currentLfoState));
  }
  renderer.invalidate();

  currentModel = nextModel;
  playback.sync();
  currentParameters = sanitizedStoredParameters(
    currentModel,
    modelParameterState.get(currentModel.id),
  );
  currentLfoState = sanitizedLfoState(
    currentModel,
    modelLfoState.get(currentModel.id),
  );
  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  modelLfoState.set(currentModel.id, deepClone(currentLfoState));
  if (!preserveTime) {
    animationEpoch = performance.now();
    lastTimeSeconds = 0;
    frameCounter = 0;
  }
  latestRender = null;
  invalidateCurrentRun();

  elements.modelSelect.value = currentModel.id;
  const neuralDreamRoute = isDreamRoute(currentModel);
  const advancedSummary = elements.advancedControls.querySelector("summary");
  if (advancedSummary)
    advancedSummary.textContent = neuralDreamRoute
      ? "FEATURE ASCENT CONTROLS"
      : "MODEL CONTROLS";
  const capture = captureCapabilities(currentModel);
  elements.inputActions.hidden =
    neuralDreamRoute ||
    (!capture.savedRun && currentModel.supportsRandomize === false);
  elements.randomizeAll.hidden = currentModel.supportsRandomize === false;
  elements.runExperiment.disabled = !capture.savedRun;
  elements.runExperiment.title = capture.savedRun
    ? "Save parameters and a preview"
    : "Simulation state is not serialized; use PNG for a snapshot";
  elements.advancedControls.open = true;
  elements.captureNote.disabled = !capture.savedRun;
  elements.saveGif.disabled = !capture.gif;
  elements.saveImage.disabled = !capture.png;
  elements.toggleAnimation.disabled = false;
  elements.modelFamily.textContent = `MODEL FAMILY: ${currentModel.family}`;
  elements.modelBackend.textContent = `BACKEND: ${currentModel.backend}`;
  elements.modelDescription.textContent = currentModel.description;
  renderModelTechnicalInfo(elements, currentModel);
  elements.canvas.style.imageRendering = currentModel.pixelated
    ? "pixelated"
    : "auto";
  elements.activeRoute.textContent = "ROUTE " + currentModel.name.toUpperCase();
  renderParameterControls();
  updateFractalTools();
  dreamController.update();
  growthController.update();
  updateAudioUi();

  if (currentModel.id === "digiface-vae") {
    setStatus(`${currentModel.name} CHECKING`);
    elements.renderState.textContent = "MODEL CHECK";
  } else {
    setStatus(`${currentModel.name} LOADING`);
  }

  renderCurrentFrame({ forceAnalysis: true, timeSeconds: lastTimeSeconds });
  updateAnimationButton();
  applyPanelVisibility({ render: false });
  updateResourceStatus();
  if (log) terminal("MODEL", `${currentModel.name} / ${currentModel.backend}`);
  return true;
}

function randomizedValue(definition) {
  if (definition.key === "seed") return randomSeed();
  if (definition.key === "grain") {
    const minimum = Number(definition.min);
    const maximum = Math.min(Number(definition.max), 0.03);
    const step = Number(definition.step) || 0.01;
    const steps = Math.max(0, Math.round((maximum - minimum) / step));
    return Number(
      (minimum + Math.floor(Math.random() * (steps + 1)) * step).toFixed(
        Math.max(0, precisionFromStep(step)),
      ),
    );
  }
  if (definition.key === "ghosting") {
    const minimum = Number(definition.min);
    const maximum = Math.min(Number(definition.max), 0.22);
    const step = Number(definition.step) || 0.01;
    const steps = Math.max(0, Math.round((maximum - minimum) / step));
    return Number(
      (minimum + Math.floor(Math.random() * (steps + 1)) * step).toFixed(
        Math.max(0, precisionFromStep(step)),
      ),
    );
  }
  if (definition.type === "select") {
    return definition.options[
      Math.floor(Math.random() * definition.options.length)
    ].value;
  }
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const step = Number(definition.step) || 1;
  const steps = Math.max(1, Math.round((maximum - minimum) / step));
  const value = minimum + Math.floor(Math.random() * (steps + 1)) * step;
  return Number(value.toFixed(Math.max(0, precisionFromStep(step))));
}

async function randomizeParameters() {
  if (currentModel.supportsRandomize === false) return;
  if (currentModel.id === "about") {
    setStatus(
      "SAVE RUN SUPPORTS PARAMETERIZED MODELS; USE SAVE PNG FOR SOURCE IMAGES",
    );
    return;
  }
  if (selectedLoopPreset().duration)
    setLoopPreset("off", { log: false, render: false });
  const constrained = typeof currentModel.randomizeParameters === "function";
  const attempts =
    constrained && typeof currentModel.isInteresting === "function" ? 8 : 1;
  let accepted = false;
  let acceptedAttempt = 1;

  setStatus(
    constrained
      ? "SEARCHING INTERESTING PARAMETER SPACE"
      : "RANDOMIZING PARAMETERS",
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    acceptedAttempt = attempt;
    const nextParameters = constrained
      ? currentModel.randomizeParameters(Math.random)
      : Object.fromEntries(
          currentModel.controls.map((definition) => [
            definition.key,
            randomizedValue(definition),
          ]),
        );

    applyParameterSet(nextParameters, {
      render: false,
      message: "PARAMETERS RANDOMIZED - SAVE WHEN READY",
    });
    const result = await renderCurrentFrame({
      forceAnalysis: true,
      exact: true,
    });
    const metrics = result?.commonMetrics || result?.metrics;
    if (!currentModel.isInteresting || currentModel.isInteresting(metrics)) {
      accepted = true;
      acceptedAttempt = attempt;
      break;
    }
  }

  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  invalidateCurrentRun("PARAMETERS RANDOMIZED - SAVE WHEN READY");
  updateEffectiveControlReadouts(effectiveParametersAt(lastTimeSeconds));
  terminal(
    "INPUT",
    constrained
      ? `${accepted ? "interesting" : "best available"} constrained state selected after ${acceptedAttempt} attempt${acceptedAttempt === 1 ? "" : "s"}`
      : "all base parameters randomized",
  );
  setStatus(
    accepted || !constrained
      ? "PARAMETERS RANDOMIZED"
      : "RANDOMIZED STATE ACCEPTED",
  );
}

function updateLivePerformance(now, renderMilliseconds) {
  smoothedRenderMs =
    smoothedRenderMs * 0.88 +
    Math.max(0.1, Number(renderMilliseconds) || 0.1) * 0.12;
  fpsFrameCount += 1;
  const elapsed = now - fpsWindowStartedAt;
  if (elapsed >= 750) {
    reportedFps = Math.round((fpsFrameCount * 1000) / elapsed);
    fpsFrameCount = 0;
    fpsWindowStartedAt = now;
  }

  const performanceText = reportedFps
    ? "LIVE " + reportedFps + " FPS · " + smoothedRenderMs.toFixed(1) + " MS"
    : "RENDER " + smoothedRenderMs.toFixed(1) + " MS";
  elements.liveFps.textContent = performanceText;
  elements.liveFps.title = "Approximate display rate and renderer time";

  if (
    document.fullscreenElement === elements.outputPanel &&
    !hqGallery.isActive() &&
    now - lastLiveResizeAt >= 1500
  ) {
    const previousScale = liveResolutionScale;
    if (smoothedRenderMs > 22 && liveResolutionScale > 0.56)
      liveResolutionScale = Math.max(0.55, liveResolutionScale * 0.82);
    else if (smoothedRenderMs < 9 && liveResolutionScale < 0.99)
      liveResolutionScale = Math.min(1, liveResolutionScale / 0.82);
    if (Math.abs(previousScale - liveResolutionScale) > 0.01)
      resizeLiveFullscreenCanvas();
    lastLiveResizeAt = now;
  }
}

function renderCurrentFrame(request) {
  return renderer.render(request);
}

function modelNeedsAnimation() {
  if (!playback.isActive() || !currentModel?.available) return false;
  if (
    rhythmController.status === "active" &&
    hasActiveAudioRoute(currentModel.id)
  )
    return true;
  if (currentModel.usesInternalClock) return false;
  if (hasActiveLfo(currentLfoState)) return true;
  if (selectedLoopPreset().duration) return true;
  const effective = effectiveParametersAt(lastTimeSeconds);
  return Boolean(currentModel.isDynamic?.(effective));
}

function animationLoop(timestamp) {
  rhythmController.update(timestamp);
  drawAudioMeter();
  const siteActive = elements.site.classList.contains("is-visible");
  const canRender =
    siteActive &&
    playback.isActive() &&
    currentView === "lab" &&
    !gifEncoding &&
    !hqRendering &&
    modelNeedsAnimation();
  const fallback = currentModel?.backend.includes("FALLBACK");
  const acceleratedFractal = isFractalRoute() && !fallback;
  const fallbackPenalty = fallback ? 35 : 0;
  const adaptiveCost = acceleratedFractal ? smoothedRenderMs * 1.05 : 0;
  const frameInterval = Math.max(
    qualityProfile.frameInterval + fallbackPenalty,
    adaptiveCost,
  );
  if (canRender && timestamp - lastRenderedAt >= frameInterval) {
    lastRenderedAt = timestamp;
    lastTimeSeconds = (timestamp - animationEpoch) / 1000;
    renderCurrentFrame({
      timeSeconds: lastTimeSeconds,
      advanceSimulation: true,
    });
  }
  animationHandle = requestAnimationFrame(animationLoop);
}

function updateAnimationButton() {
  elements.toggleAnimation.textContent = `CLOCK: ${animationEnabled ? "ON" : "OFF"}`;
  elements.toggleAnimation.classList.toggle("is-active", animationEnabled);
  elements.toggleAnimation.setAttribute(
    "aria-pressed",
    String(animationEnabled),
  );
}

function setAnimation(enabled, { log = true } = {}) {
  const next = Boolean(enabled);
  if (next === animationEnabled) {
    playback.sync();
    return;
  }
  animationEnabled = next;
  playback.sync();
  if (animationEnabled) {
    animationEpoch = performance.now() - lastTimeSeconds * 1000;
  }
  renderCurrentFrame({ forceAnalysis: true, timeSeconds: lastTimeSeconds });
  updateAnimationButton();
  if (log)
    terminal(
      "CLOCK",
      animationEnabled
        ? "enabled; motion and LFOs may advance"
        : "paused; all time-based modulation is frozen",
    );
  setStatus(animationEnabled ? "ANIMATION CLOCK ENABLED" : "ALL MOTION PAUSED");
}

function updateResourceStatus() {
  const memory = capabilities.memoryGb
    ? `${capabilities.memoryGb} GB`
    : "MEMORY N/A";
  const autoText =
    qualityProfile.requestedMode === "auto"
      ? `AUTO>${qualityProfile.mode.toUpperCase()}`
      : qualityProfile.mode.toUpperCase();
  elements.resourceStatus.textContent = `${autoText} ${qualityProfile.size} / ${registry.rendererSummary()} / ${capabilities.threads} THREADS / ${memory}`;
}

function applyQuality(mode, { render = true, log = true } = {}) {
  const allowed = new Set(qualityOptions().map((option) => option.value));
  qualityMode = allowed.has(mode) ? mode : "auto";
  qualityProfile = resolveQuality(qualityMode, capabilities);
  saveQualityMode(qualityMode);
  elements.qualitySelect.value = qualityMode;
  if (
    document.fullscreenElement === elements.outputPanel &&
    !hqGallery.isActive()
  ) {
    liveResolutionScale = 1;
    resizeLiveFullscreenCanvas({ render: false });
  } else {
    elements.canvas.width = qualityProfile.size;
    elements.canvas.height = qualityProfile.size;
    elements.outputResolution.textContent =
      qualityProfile.size + " x " + qualityProfile.size;
  }
  updateResourceStatus();
  invalidateCurrentRun("QUALITY CHANGED - SAVE WHEN READY");
  if (render) renderCurrentFrame({ forceAnalysis: true });
  if (log)
    terminal(
      "QUALITY",
      `${qualityMode.toUpperCase()} -> ${qualityProfile.size} x ${qualityProfile.size}`,
    );
}

function makeThumbnail() {
  const size = 220;
  const thumbnail = document.createElement("canvas");
  thumbnail.width = size;
  thumbnail.height = size;
  const thumbnailContext = thumbnail.getContext("2d", { alpha: false });
  thumbnailContext.fillStyle = "#000";
  thumbnailContext.fillRect(0, 0, size, size);
  thumbnailContext.imageSmoothingEnabled = true;
  thumbnailContext.imageSmoothingQuality = "high";
  thumbnailContext.drawImage(elements.canvas, 0, 0, size, size);
  return thumbnail.toDataURL("image/jpeg", 0.72);
}

function materializeVisibleParameters(parameters) {
  const visible = { ...parameters };
  if (Number.isFinite(Number(visible.__seedB))) {
    const amount = clamp(Number(visible.__seedMix) || 0, 0, 1);
    const smooth = amount * amount * (3 - 2 * amount);
    visible.seed = Math.round(
      Number(visible.seed) +
        (Number(visible.__seedB) - Number(visible.seed)) * smooth,
    );
  }
  delete visible.__seedB;
  delete visible.__seedMix;
  return sanitizedStoredParameters(currentModel, visible);
}

async function saveCurrentRun() {
  if (
    !currentModel?.available ||
    !captureCapabilities(currentModel).savedRun ||
    currentView !== "lab"
  ) {
    setStatus(
      currentModel?.statefulSimulation
        ? "USE PNG FOR A SIMULATION SNAPSHOT; SAVED RUNS DO NOT STORE GRID STATE"
        : "CHOOSE A MODEL ROUTE FIRST",
    );
    return null;
  }
  elements.renderState.textContent = "SAVING RUN";
  elements.renderState.classList.add("is-processing");
  const renderResult = await renderCurrentFrame({
    forceAnalysis: true,
    timeSeconds: lastTimeSeconds,
    exact: true,
  });
  if (!renderResult) return null;

  const record = ExperimentStore.add({
    modelId: currentModel.id,
    modelName: currentModel.name,
    modelFamily: currentModel.family,
    backend: renderResult.backend,
    parameters: deepClone(currentParameters),
    effectiveParameters: deepClone(
      materializeVisibleParameters(renderResult.effectiveParameters),
    ),
    modulation: deepClone(currentLfoState),
    audioModulation: deepClone(audioMatrixForModel(currentModel.id)),
    animationRunning: Boolean(animationEnabled),
    frameTimeSeconds: Number(lastTimeSeconds.toFixed(5)),
    qualityMode,
    qualityResolvedMode: qualityProfile.mode,
    qualityResolution: qualityProfile.size,
    metrics: deepClone(renderResult.metrics),
    modelMetrics: deepClone(renderResult.modelMetrics),
    thumbnail: makeThumbnail(),
    note: elements.captureNote.value.trim(),
  });

  elements.runId.textContent = record.id;
  const persistent = ExperimentStore.isPersistent();
  elements.captureStatus.textContent = `${record.id} ${persistent ? "SAVED LOCALLY" : "SESSION ONLY"}`;
  elements.captureStatus.classList.add("is-saved");
  elements.captureNote.value = record.note || "";
  elements.renderState.textContent = "RUN SAVED";
  elements.renderState.classList.remove("is-processing");
  terminal(
    "SAVED",
    `${record.id} / ${record.modelName} / ${record.qualityResolution}px`,
  );
  archiveController.render();
  setStatus(
    `${record.id} ${persistent ? "SAVED" : "SESSION ONLY — EXPORT TO KEEP"}`,
  );
  return record;
}

function applyPanelVisibility({ render = true } = {}) {
  const definitions = [
    ["input", elements.inputPanel, elements.toggleInput],
    ["terminal", elements.terminalPanel, elements.toggleTerminal],
  ];

  definitions.forEach(([key, panel, button]) => {
    const visible = panelVisibility[key] !== false;
    panel?.classList.toggle("is-panel-hidden", !visible);
    button?.classList.toggle("is-active", visible);
    button?.setAttribute("aria-pressed", String(visible));
    if (button) button.title = `${visible ? "Hide" : "Show"} ${key} panel`;
  });

  elements.labGrid.classList.toggle("is-input-hidden", !panelVisibility.input);
  elements.labGrid.classList.toggle(
    "is-terminal-hidden",
    !panelVisibility.terminal,
  );
  savePanelVisibility();
  if (render)
    window.setTimeout(() => renderCurrentFrame({ forceAnalysis: true }), 30);
}

function togglePanel(key) {
  if (!(key in panelVisibility)) return;
  panelVisibility[key] = !panelVisibility[key];
  applyPanelVisibility();
  const label = key.toUpperCase();
  terminal(
    "LAYOUT",
    `${label} panel ${panelVisibility[key] ? "shown" : "hidden"}`,
  );
  setStatus(`${label} PANEL ${panelVisibility[key] ? "SHOWN" : "HIDDEN"}`);
}

function fullscreenLiveDimensions() {
  const bounds = elements.outputStage.getBoundingClientRect();
  const aspect = Math.max(0.2, bounds.width / Math.max(1, bounds.height));
  const profileEdges = {
    economy: 960,
    standard: 1280,
    high: 1600,
    ultra: 1920,
    extreme: 2560,
  };
  const baseEdge = profileEdges[qualityProfile.mode] || 1280;
  const longEdge = Math.max(
    512,
    Math.min(
      capabilities.maxTextureSize || 2048,
      Math.round(baseEdge * liveResolutionScale),
    ),
  );
  if (aspect >= 1)
    return {
      width: longEdge,
      height: Math.max(1, Math.round(longEdge / aspect)),
    };
  return {
    width: Math.max(1, Math.round(longEdge * aspect)),
    height: longEdge,
  };
}

function resizeLiveFullscreenCanvas({ render = true } = {}) {
  if (
    document.fullscreenElement !== elements.outputPanel ||
    hqGallery.isActive()
  )
    return;
  const { width, height } = fullscreenLiveDimensions();
  if (elements.canvas.width === width && elements.canvas.height === height)
    return;
  elements.canvas.width = width;
  elements.canvas.height = height;
  elements.outputResolution.textContent = width + " × " + height;
  if (render) renderCurrentFrame({ forceAnalysis: true });
}

function restoreLiveCanvasSize({ render = true } = {}) {
  elements.canvas.width = qualityProfile.size;
  elements.canvas.height = qualityProfile.size;
  elements.outputResolution.textContent =
    qualityProfile.size + " × " + qualityProfile.size;
  if (render) renderCurrentFrame({ forceAnalysis: true });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.outputPanel.requestFullscreen();
    }
  } catch (error) {
    terminal(
      "FULLSCREEN",
      error instanceof Error ? error.message : String(error),
      "warning",
    );
    setStatus("FULLSCREEN NOT AVAILABLE");
  }
}

function updateFullscreenUi() {
  const active = document.fullscreenElement === elements.outputPanel;
  elements.toggleFullscreen.classList.toggle("is-active", active);
  elements.toggleFullscreen.textContent = active
    ? "EXIT FULLSCREEN"
    : "FULLSCREEN";
  elements.toggleFullscreen.setAttribute("aria-pressed", String(active));
  if (active) {
    window.setTimeout(() => resizeLiveFullscreenCanvas(), 40);
  } else {
    if (hqGallery.isActive()) hqGallery.closeViewer({ exitFullscreen: false });
    liveResolutionScale = 1;
    restoreLiveCanvasSize();
  }
  setStatus(
    active
      ? hqGallery.isActive()
        ? "HQ VERSION FULLSCREEN"
        : "OUTPUT FULLSCREEN"
      : "FULLSCREEN CLOSED",
  );
}

function navigate(view, updateHash = true) {
  return navigation.navigate(view, updateHash);
}

function restoreRun(record) {
  if (gifEncoding || hqRendering || playback.isSuspended()) return;
  const model = registry.get(record.modelId);
  if (!model?.available) {
    terminal(
      "RESTORE",
      `${record.modelName} is not currently available`,
      "warning",
    );
    navigate("experiments");
    return;
  }
  if (record.qualityMode)
    applyQuality(record.qualityMode, { render: false, log: false });
  selectModel(record.modelId, { log: false, preserveTime: true });
  currentParameters = sanitizedStoredParameters(
    currentModel,
    record.parameters || record.effectiveParameters,
  );
  currentLfoState = sanitizedLfoState(currentModel, record.modulation);
  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  modelLfoState.set(currentModel.id, deepClone(currentLfoState));
  restoreAudioMatrix(
    currentModel.id,
    record.audioModulation,
    currentModel.controls
      .filter((definition) => supportsModulation(currentModel, definition))
      .map(({ key }) => key),
  );
  lastTimeSeconds = Number(record.frameTimeSeconds || 0);
  animationEpoch = performance.now() - lastTimeSeconds * 1000;
  const hasLfo = hasActiveLfo(currentLfoState);
  const hasAudio = hasActiveAudioRoute(currentModel.id);
  const shouldAnimate = hasLfo || hasAudio || Boolean(record.animationRunning);
  setAnimation(shouldAnimate, { log: false });
  renderParameterControls();
  navigate("lab");
  renderCurrentFrame({ forceAnalysis: true, timeSeconds: lastTimeSeconds });
  elements.runId.textContent = record.id;
  elements.captureStatus.textContent = `${record.id} RESTORED`;
  elements.captureStatus.classList.add("is-saved");
  elements.captureNote.value = record.note || "";
  const modulationNotes = [];
  if (hasLfo) modulationNotes.push("LFOs active");
  if (hasAudio) modulationNotes.push("Audio reactive");
  const modSummary = modulationNotes.length
    ? ` (${modulationNotes.join(", ")})`
    : "";
  terminal("RESTORE", `${record.id} / ${record.modelName}${modSummary}`);
  if (hasAudio && rhythmController.status !== "active") {
    terminal(
      "AUDIO",
      "Restored run has audio-reactive parameters. Click [AUDIO: OFF] to connect audio input.",
    );
  }
  setStatus(`${record.id} RESTORED`);
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function attachEvents() {
  elements.brandHome.addEventListener("click", () => navigate("lab"));
  elements.navItems.forEach((button) =>
    button.addEventListener("click", () => navigate(button.dataset.view)),
  );
  elements.qualitySelect.addEventListener("change", () =>
    applyQuality(elements.qualitySelect.value),
  );
  elements.toggleInput.addEventListener("click", () => togglePanel("input"));
  elements.toggleTerminal.addEventListener("click", () =>
    togglePanel("terminal"),
  );
  elements.toggleFullscreen.addEventListener("click", toggleFullscreen);
  elements.toggleAudioInput.addEventListener("click", () =>
    toggleAudioInput(setAnimation, terminal, setStatus, renderCurrentFrame),
  );
  elements.neuralDreamImage.addEventListener(
    "change",
    dreamController.sourceChanged,
  );
  elements.loadNeuralDream.addEventListener("click", dreamController.loadModel);
  elements.neuralDreamModeButtons.forEach((button) => {
    button.addEventListener("click", () =>
      dreamController.setMode(button.dataset.dreamMode),
    );
  });
  elements.pauseNeuralDream?.addEventListener(
    "click",
    dreamController.togglePause,
  );
  elements.moreNeuralDream?.addEventListener(
    "click",
    dreamController.dreamMore,
  );
  elements.resetNeuralDream.addEventListener("click", dreamController.reset);
  elements.classicFractalView.addEventListener("change", () =>
    applyClassicFractalView(elements.classicFractalView.value),
  );
  elements.canvas.addEventListener("pointerdown", startCanvasGesture);
  elements.canvas.addEventListener("pointermove", moveCanvasGesture);
  ["pointerup", "pointercancel"].forEach((type) =>
    elements.canvas.addEventListener(type, endCanvasGesture),
  );
  elements.canvas.addEventListener("contextmenu", (event) => {
    if (supportsCanvasExploration()) event.preventDefault();
  });
  elements.canvas.addEventListener("wheel", zoomCanvasWithWheel, {
    passive: false,
  });
  elements.hqViewerDownload.addEventListener("click", () =>
    hqGallery.downloadActive(),
  );
  elements.hqViewerClose.addEventListener("click", () =>
    hqGallery.closeViewer(),
  );
  elements.fractalProcessButtons.forEach((button) => {
    button.addEventListener("click", () =>
      setFractalProcessStep(button.dataset.fractalStep),
    );
  });
  document.addEventListener("visibilitychange", () => {
    playback.sync();
    if (!document.hidden && currentView === "lab")
      renderCurrentFrame({ forceAnalysis: true });
  });
  document.addEventListener("fullscreenchange", updateFullscreenUi);
  window.addEventListener("resize", () => {
    if (
      document.fullscreenElement === elements.outputPanel &&
      !hqGallery.isActive()
    ) {
      window.setTimeout(() => resizeLiveFullscreenCanvas(), 80);
    }
  });
  elements.modelSelect.addEventListener("change", () =>
    selectModel(elements.modelSelect.value),
  );
  elements.runExperiment.addEventListener("click", saveCurrentRun);
  elements.randomizeAll.addEventListener("click", randomizeParameters);
  elements.toggleAnimation.addEventListener("click", () =>
    setAnimation(!animationEnabled),
  );
  elements.saveImage.addEventListener("click", savePng);
  elements.saveGif.addEventListener("click", saveGif);

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      saveCurrentRun();
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setAnimation(!animationEnabled);
    }
  });

  window.addEventListener("hashchange", () => {
    navigate(window.location.hash.slice(1), false);
  });
}

function initializeQualityControls() {
  elements.qualitySelect.replaceChildren();
  qualityOptions().forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    elements.qualitySelect.append(option);
  });
  applyQuality(qualityMode, { render: false, log: false });
}

function initialize() {
  initializeQualityControls();
  initializeFractalToolOptions();
  setFractalProcessStep("fold");
  studioController.initialize();
  refreshModelOptions(currentModel.id);
  currentParameters = defaultParameters(currentModel);
  currentLfoState = defaultLfoState(currentModel);
  modelParameterState.set(currentModel.id, deepClone(currentParameters));
  modelLfoState.set(currentModel.id, deepClone(currentLfoState));
  selectModel(currentModel.id, { log: false });
  const hashView = window.location.hash.slice(1);
  if (hashView) navigate(resolveView(hashView), false);
  archiveController.initialize();
  hqGallery.render();
  updateAnimationButton();
  applyPanelVisibility({ render: false });
  updateResourceStatus();
  rhythmController.subscribe(() => {
    updateAudioUi();
  });
  updateAudioUi();

  terminal("BOOT", "LATENT FIELD full-screen local model lab");
  terminal(
    "QUALITY",
    `${qualityMode.toUpperCase()} -> ${qualityProfile.mode.toUpperCase()} / ${qualityProfile.size}px`,
  );
  terminal(
    "RENDERER",
    `${registry.rendererSummary()} / ${capabilities.threads} logical threads reported`,
  );
  terminal(
    "MODEL ROUTES",
    `${registry.getAll().length} registered / ${registry.getAll().filter((model) => model.available).length} available`,
  );
  terminal(
    "READY",
    "save frames, modulate parameters, or build a local image basis in Experiments",
  );
  attachEvents();
  animationHandle = requestAnimationFrame(animationLoop);
}

initialize();

window.addEventListener("beforeunload", () => {
  currentModel?.cancel?.();
  registry.dispose();
  rhythmController.stop();
  cancelAnimationFrame(animationHandle);
  studioController.dispose();
  archiveController.dispose();
  hqGallery.dispose();
  growthController.dispose();
});
