import { clamp } from "./utils.js";

export function defaultParameters(model) {
  return Object.fromEntries(
    model.controls.map(({ key, default: value }) => [key, value]),
  );
}

export function sanitizeParameters(model, stored) {
  const parameters = defaultParameters(model);
  if (!stored || typeof stored !== "object") return parameters;
  for (const definition of model.controls) {
    if (!(definition.key in stored)) continue;
    const value =
      model.normalizeStoredParameter?.(
        definition.key,
        stored[definition.key],
      ) ?? stored[definition.key];
    if (definition.type === "select") {
      const option = definition.options.find(
        (entry) => String(entry.value) === String(value),
      );
      if (option) parameters[definition.key] = option.value;
    } else if (definition.type === "color") {
      if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
        parameters[definition.key] = value.trim();
      }
    } else if (Number.isFinite(Number(value))) {
      const bounded = clamp(Number(value), definition.min, definition.max);
      parameters[definition.key] =
        Number(definition.step) >= 1 ? Math.round(bounded) : bounded;
    }
  }
  return parameters;
}

export function supportsModulation(model, definition) {
  if (
    definition.type !== "range" ||
    definition.modulation === false ||
    model.usesInternalClock
  )
    return false;
  return model.supportsModulation !== false;
}

export function validateModelDefinition(model) {
  for (const [key, value] of Object.entries(model.captureCapabilities || {})) {
    if (
      !["png", "gif", "highResolution", "savedRun"].includes(key) ||
      typeof value !== "boolean"
    ) {
      throw new Error(`Invalid capture capability in ${model.id}: ${key}`);
    }
  }
  if (!model.id || !model.name || typeof model.render !== "function") {
    throw new Error("A model requires an id, name, and render method.");
  }
  const keys = new Set();
  for (const control of model.controls) {
    if (
      !control.key ||
      keys.has(control.key) ||
      !["range", "number", "select", "color"].includes(control.type)
    ) {
      throw new Error(`Invalid control schema in ${model.id}: ${control.key}`);
    }
    keys.add(control.key);
    if (control.type === "select") {
      if (
        !control.options?.some(
          ({ value }) => String(value) === String(control.default),
        )
      ) {
        throw new Error(
          `Invalid default option in ${model.id}: ${control.key}`,
        );
      }
    } else if (control.type === "color") {
      if (
        typeof control.default !== "string" ||
        !/^#[0-9a-fA-F]{3,8}$/.test(control.default.trim())
      ) {
        throw new Error(`Invalid color default in ${model.id}: ${control.key}`);
      }
    } else if (
      ![control.min, control.max, control.step, control.default].every(
        Number.isFinite,
      ) ||
      control.min > control.max ||
      control.step <= 0 ||
      control.default < control.min ||
      control.default > control.max
    ) {
      throw new Error(`Invalid numeric bounds in ${model.id}: ${control.key}`);
    }
  }
}

// Capture support is independent of who owns a model's playback clock.
export function captureCapabilities(model) {
  return {
    png: true,
    gif: !model?.usesInternalClock,
    highResolution: true,
    savedRun: !model?.usesInternalClock,
    ...model?.captureCapabilities,
  };
}
