import { clamp } from "./utils.js";
import { applyParameterBoundary } from "./lfo.js";

export const MODULATION_SOURCES = Object.freeze(
  [
    { value: "none", label: "Off", level: null },
    { value: "audioBass", label: "Bass", level: "bass" },
    { value: "audioBody", label: "Body", level: "body" },
    { value: "audioAir", label: "Air", level: "air" },
    { value: "audioBeat", label: "Kick", level: "kick" },
    { value: "audioActivity", label: "Energy", level: "activity" },
  ].map(Object.freeze),
);
const VALID_SOURCES = new Set([
  ...MODULATION_SOURCES.map(({ value }) => value),
  "bass",
  "kick",
]);
const DEFAULT_DEPTH = 0.25;
const modulationMatrixState = new Map();
const routeId = (modelId, key) => `${modelId}:${key}`;

function sanitizeAudioRoute(route) {
  const depth = route?.depth;
  const numeric =
    typeof depth === "number" ||
    (typeof depth === "string" && depth.trim() !== "")
      ? Number(depth)
      : NaN;
  const owner = route?.owner === "preset" ? "preset" : "user";
  return {
    source: VALID_SOURCES.has(route?.source) ? route.source : "none",
    depth: Number.isFinite(numeric) ? clamp(numeric, -1, 1) : DEFAULT_DEPTH,
    owner,
    ...(owner === "preset" && route?.ceiling === 0.7 ? { ceiling: 0.7 } : {}),
  };
}
export function getAudioRoute(modelId, key) {
  return sanitizeAudioRoute(modulationMatrixState.get(routeId(modelId, key)));
}
export function setAudioRoute(modelId, key, route) {
  const next = sanitizeAudioRoute(route);
  // Keep explicit user Off choices so presets cannot silently claim them.
  modulationMatrixState.set(routeId(modelId, key), Object.freeze(next));
  return next;
}
export function audioMatrixForModel(modelId) {
  const prefix = `${modelId}:`;
  return Object.fromEntries(
    [...modulationMatrixState]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, route]) => [key.slice(prefix.length), { ...route }]),
  );
}
export function restoreAudioMatrix(modelId, matrix, parameterKeys = []) {
  for (const key of modulationMatrixState.keys())
    if (key.startsWith(`${modelId}:`)) modulationMatrixState.delete(key);
  const allowed = new Set(parameterKeys);
  for (const [key, route] of Object.entries(matrix || {}))
    if (allowed.has(key) && VALID_SOURCES.has(route?.source))
      setAudioRoute(modelId, key, route);
}
export function hasActiveAudioRoute(modelId) {
  const prefix = `${modelId}:`;
  for (const [key, route] of modulationMatrixState) {
    if (key.startsWith(prefix) && route.source !== "none" && route.depth !== 0)
      return true;
  }
  return false;
}
export function getModulationLevel(source, levels) {
  if (!levels) return 0;
  const key = MODULATION_SOURCES.find(({ value }) => value === source)?.level;
  return clamp(
    Number(
      source === "bass"
        ? (levels.music ?? levels.bass)
        : source === "kick"
          ? levels.kick
          : levels[key],
    ) || 0,
    0,
    1,
  );
}
export function audioModulationDelta(definition, route, levels) {
  const config = sanitizeAudioRoute(route);
  return (
    getModulationLevel(config.source, levels) *
    config.depth *
    (Number(definition.max) - Number(definition.min)) *
    0.5
  );
}
export function applyAudioModulation(
  definition,
  value,
  route,
  levels,
  baseValue = value,
) {
  if (definition.type !== "range") return Number(value);
  const delta = audioModulationDelta(definition, route, levels);
  let result = Number(value) + delta;
  if (route?.owner === "preset" && route.ceiling === 0.7)
    result =
      Number(value) +
      Math.min(
        delta,
        Math.max(0, Math.max(Number(baseValue), 0.7) - Number(value)),
      );
  return applyParameterBoundary(definition, result);
}

// Mutate a caller-owned result. A periodic interval may straddle the slider seam.
export function updateModulationBounds(
  result,
  definition,
  base,
  lfoDepth,
  audioDepth,
  polarity = "bipolar",
  audioCeiling = null,
) {
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  result.wrapLeftPercent = 0;
  result.wrapWidthPercent = 0;
  if (!(range > 0)) {
    result.leftPercent = 0;
    result.widthPercent = 0;
    return result;
  }
  const lfoSpan = Math.abs(clamp(lfoDepth, -1, 1)) * range * 0.5;
  const audioReach = clamp(audioDepth, -1, 1) * range * 0.5;
  let low =
    Number(base) -
    (polarity === "positive" ? 0 : lfoSpan) +
    Math.min(0, audioReach);
  let high =
    Number(base) +
    (polarity === "negative" ? 0 : lfoSpan) +
    Math.max(0, audioReach);
  if (audioCeiling !== null && audioReach > 0) {
    const lfoHigh = Number(base) + (polarity === "negative" ? 0 : lfoSpan);
    high = Math.max(
      lfoHigh,
      Math.min(high, Math.max(Number(base), audioCeiling)),
    );
  }
  if (definition.wrap) {
    const span = Math.min(range, high - low);
    low = applyParameterBoundary(definition, low);
    high = low + span;
    result.wrapWidthPercent = Math.max(0, ((high - maximum) / range) * 100);
    high = Math.min(high, maximum);
  } else {
    low = clamp(low, minimum, maximum);
    high = clamp(high, minimum, maximum);
  }
  result.leftPercent = ((low - minimum) / range) * 100;
  result.widthPercent = Math.max(0, ((high - low) / range) * 100);
  return result;
}
