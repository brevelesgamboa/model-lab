import { clamp } from "./utils.js";
import { inceptionSensor } from "../models/neural-growth/inception-sensor.js";

export const AUDIO_MODULATION_SOURCES = Object.freeze([
  { value: "none", label: "NONE" },
  { value: "bass", label: "BASS / MUSIC" },
  { value: "kick", label: "KICK" },
  { value: "inception", label: "NEURAL ENERGY" },
]);

const VALID_SOURCES = new Set(
  AUDIO_MODULATION_SOURCES.map(({ value }) => value),
);
const DEFAULT_DEPTH = 0.25;

function routeId(modelId, parameterKey) {
  return `${modelId}:${parameterKey}`;
}

export const modulationMatrixState = new Map();

export function defaultAudioRoute() {
  return {
    source: "none",
    depth: DEFAULT_DEPTH,
  };
}

export function sanitizeAudioRoute(route) {
  const source = VALID_SOURCES.has(route?.source) ? route.source : "none";
  return {
    source,
    depth: clamp(Number(route?.depth ?? DEFAULT_DEPTH), -1, 1),
  };
}

export function getAudioRoute(modelId, parameterKey) {
  return sanitizeAudioRoute(
    modulationMatrixState.get(routeId(modelId, parameterKey)) ||
      defaultAudioRoute(),
  );
}

export function setAudioRoute(modelId, parameterKey, route) {
  const next = sanitizeAudioRoute(route);
  const key = routeId(modelId, parameterKey);
  if (next.source === "none") modulationMatrixState.delete(key);
  else modulationMatrixState.set(key, Object.freeze({ ...next }));
  return next;
}

export function audioMatrixForModel(modelId) {
  const prefix = `${modelId}:`;
  const matrix = {};
  modulationMatrixState.forEach((route, key) => {
    if (!key.startsWith(prefix)) return;
    matrix[key.slice(prefix.length)] = sanitizeAudioRoute(route);
  });
  return matrix;
}

export function restoreAudioMatrix(modelId, matrix, parameterKeys = []) {
  const prefix = `${modelId}:`;
  [...modulationMatrixState.keys()].forEach((key) => {
    if (key.startsWith(prefix)) modulationMatrixState.delete(key);
  });
  const allowed = new Set(parameterKeys);
  Object.entries(matrix || {}).forEach(([parameterKey, route]) => {
    if (!allowed.has(parameterKey)) return;
    setAudioRoute(modelId, parameterKey, route);
  });
}

export function hasActiveAudioRoute(modelId) {
  const prefix = `${modelId}:`;
  return [...modulationMatrixState.entries()].some(
    ([key, route]) => key.startsWith(prefix) && route.source !== "none",
  );
}

export function hasModulationSource(modelId, source) {
  const prefix = `${modelId}:`;
  return [...modulationMatrixState.entries()].some(
    ([key, route]) => key.startsWith(prefix) && route.source === source,
  );
}

export function getModulationLevel(source, levels) {
  return clamp(
    Number(
      source === "inception" ? inceptionSensor.getLevel() : levels?.[source],
    ) || 0,
    0,
    1,
  );
}

export function applyAudioModulation(definition, value, route, levels) {
  const config = sanitizeAudioRoute(route);
  if (definition.type !== "range" || config.source === "none")
    return Number(value);
  const level = getModulationLevel(config.source, levels);
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  return clamp(
    Number(value) + level * config.depth * range * 0.5,
    minimum,
    maximum,
  );
}

// Mutate a caller-owned result so live slider feedback needs no temporary object.
export function updateModulationBounds(
  result,
  definition,
  base,
  lfoDepth,
  audioDepth,
  polarity = "bipolar",
) {
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  if (!(range > 0)) {
    result.leftPercent = 0;
    result.widthPercent = 0;
    return result;
  }
  const halfSpan = range * 0.5;
  const lfoSpan = Math.abs(clamp(lfoDepth, -1, 1)) * halfSpan;
  const audioReach = clamp(audioDepth, -1, 1) * halfSpan;
  const reachMin = clamp(
    base - (polarity === "positive" ? 0 : lfoSpan) + Math.min(0, audioReach),
    minimum,
    maximum,
  );
  const reachMax = clamp(
    base + (polarity === "negative" ? 0 : lfoSpan) + Math.max(0, audioReach),
    minimum,
    maximum,
  );
  result.leftPercent = ((reachMin - minimum) / range) * 100;
  result.widthPercent = Math.max(0, ((reachMax - reachMin) / range) * 100);
  return result;
}
