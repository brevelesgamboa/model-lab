import { getAudioRoute, setAudioRoute } from "../core/modulation-matrix.js";
import { clamp } from "../core/utils.js";
import { createModulationDrawer } from "./workbench-shell.js";

export function modulationIsActive(config, audioRoute) {
  return Boolean(
    config?.enabled || (audioRoute && audioRoute.source !== "none"),
  );
}

export function makeModulationPanel({
  definition,
  config,
  supportsLfo,
  modelId,
  previewBridge,
  onBrowseSensor,
  getVisibleBase,
  coerceRangeValue,
  onCaptureBase,
  onChange,
}) {
  let audioRoute = getAudioRoute(modelId, definition.key);
  let syncStrip = () => {};
  const panel = document.createElement("div");
  panel.className = "modulation-panel";
  panel.hidden = !modulationIsActive(config, audioRoute);
  const updateConfig = (wasActive = modulationIsActive(config, audioRoute)) => {
    audioRoute = setAudioRoute(modelId, definition.key, audioRoute);
    drawer.sync();
    const active = modulationIsActive(config, audioRoute);
    onChange({
      config,
      audioRoute,
      active,
      activated: active && !wasActive,
    });
  };
  const syncLfoConfig = (nextConfig) => {
    if (!nextConfig) return;
    config = { ...config, ...nextConfig };
    drawer.sync();
    syncStrip();
  };
  const syncAudioRoute = (nextRoute) => {
    if (!nextRoute) return;
    audioRoute = { ...audioRoute, ...nextRoute };
    drawer.sync();
  };
  const setLfoConfig = (next) => {
    const wasActive = modulationIsActive(config, audioRoute);
    syncLfoConfig(next);
    updateConfig(wasActive);
  };
  const drawer = createModulationDrawer({
    definition,
    supportsLfo,
    previewBridge,
    onBrowseSensor,
    getLfoConfig: () => config,
    getAudioRoute: () => audioRoute,
    onLfoChange: (key, value) => setLfoConfig({ [key]: value }),
    onAudioSource(source) {
      const wasActive = modulationIsActive(config, audioRoute);
      audioRoute.source = source;
      if (source !== "none") {
        const base = Number(getVisibleBase());
        if (Number.isFinite(base))
          onCaptureBase(coerceRangeValue(definition, base));
      }
      updateConfig(wasActive);
    },
    onAudioDepth(value) {
      audioRoute.depth = clamp(Number(value), -1, 1);
      updateConfig();
    },
  });
  panel.append(drawer.element);
  return {
    panel,
    drawer,
    syncAudioRoute,
    syncLfoConfig,
    setLfoConfig,
    getLfoConfig: () => config,
    bindStripSync(sync) {
      syncStrip = sync;
      syncStrip();
    },
  };
}
