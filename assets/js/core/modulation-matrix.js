import { clamp } from "./utils.js";

export const AUDIO_MODULATION_SOURCES = Object.freeze([
  { value: "none", label: "NONE" },
  { value: "bass", label: "BASS / MUSIC" },
  { value: "kick", label: "KICK" },
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

export function applyAudioModulation(definition, value, route, levels) {
  const config = sanitizeAudioRoute(route);
  if (definition.type !== "range" || config.source === "none")
    return Number(value);
  const level = clamp(Number(levels?.[config.source]) || 0, 0, 1);
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  return clamp(
    Number(value) + level * config.depth * range * 0.5,
    minimum,
    maximum,
  );
}
