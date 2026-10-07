import { safeJsonParse } from "./utils.js";

const OLD_BRAND = ["unknown", "sight"].join("-");
const STORAGE_KEY = "latent-field-custom-pca-v1";
const LEGACY_STORAGE_KEYS = [
  OLD_BRAND + "-custom-pca-v2",
  OLD_BRAND + "-custom-pca-v1",
];
const CURRENT_SCHEMA = "latent-field-local-pca-v1";
const LEGACY_SCHEMAS = [
  OLD_BRAND + "-local-pca-v1",
  OLD_BRAND + "-local-pca-v2",
];
const ALLOWED_DIMENSIONS = new Set([32, 48]);
let memoryModel = null;
let persistent = true;

export function validateCustomModel(input) {
  if (!input || typeof input !== "object")
    throw new Error("Model file is not an object.");
  const model = { ...input };
  if (![CURRENT_SCHEMA, ...LEGACY_SCHEMAS].includes(model.schema)) {
    throw new Error("Unsupported model schema.");
  }
  if (!Number.isInteger(model.width) || !Number.isInteger(model.height)) {
    throw new Error("Invalid model dimensions.");
  }
  if (model.width !== model.height || !ALLOWED_DIMENSIONS.has(model.width)) {
    throw new Error(
      "This build accepts square 32 × 32 or 48 × 48 local models.",
    );
  }

  model.channels =
    model.schema === LEGACY_SCHEMAS[0] ? 1 : Number(model.channels || 1);
  if (![1, 3].includes(model.channels))
    throw new Error("Color channels must be 1 or 3.");
  const vectorLength = model.width * model.height * model.channels;

  if (!Array.isArray(model.mean) || model.mean.length !== vectorLength) {
    throw new Error("Mean vector is invalid.");
  }
  if (!model.mean.every(Number.isFinite))
    throw new Error("Mean vector contains non-finite values.");
  if (
    !Array.isArray(model.basis) ||
    model.basis.length < 1 ||
    model.basis.length > 12
  ) {
    throw new Error("Basis vectors are invalid.");
  }
  model.basis.forEach((vector) => {
    if (!Array.isArray(vector) || vector.length !== vectorLength) {
      throw new Error("A basis vector has the wrong length.");
    }
    if (!vector.every(Number.isFinite))
      throw new Error("Basis vector contains non-finite values.");
  });
  if (
    !Array.isArray(model.explainedVariance) ||
    model.explainedVariance.length !== model.basis.length
  ) {
    throw new Error("Explained variance is invalid.");
  }
  if (
    !Array.isArray(model.explainedVarianceRatio) ||
    model.explainedVarianceRatio.length !== model.basis.length
  ) {
    throw new Error("Explained variance ratio is invalid.");
  }
  if (
    ![...model.explainedVariance, ...model.explainedVarianceRatio].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  ) {
    throw new Error("Variance values must be finite and nonnegative.");
  }

  model.schema = CURRENT_SCHEMA;
  model.version = model.version || "1.0.0";
  model.name = String(model.name || "LOCAL_COLOR_BASIS").slice(0, 32);
  model.colorSpace = model.channels === 3 ? "sRGB" : "GRAYSCALE";
  model.trainingSamples = Number(model.trainingSamples) || 0;
  model.totalVarianceRetained =
    Number(model.totalVarianceRetained) ||
    model.explainedVarianceRatio.reduce(
      (sum, value) => sum + Number(value || 0),
      0,
    );
  model.sources = Array.isArray(model.sources)
    ? model.sources.slice(0, 64)
    : [];
  return model;
}

function readFromStorage() {
  const raw =
    window.localStorage.getItem(STORAGE_KEY) ||
    LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(
      Boolean,
    );
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed) throw new Error("Stored model JSON is damaged.");
  return validateCustomModel(parsed);
}

export const CustomModelStore = {
  load() {
    if (!persistent) return memoryModel;
    try {
      const model = readFromStorage();
      if (model && !window.localStorage.getItem(STORAGE_KEY)) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
      }
      memoryModel = model;
      return model;
    } catch (error) {
      console.warn("Custom model could not be loaded.", error);
      return null;
    }
  },

  save(model) {
    const valid = validateCustomModel(model);
    memoryModel = valid;
    if (!persistent) return valid;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
    } catch (error) {
      console.warn(
        "Custom model storage is unavailable. Keeping it in memory.",
        error,
      );
      persistent = false;
    }
    return valid;
  },

  clear() {
    memoryModel = null;
    if (!persistent) return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      persistent = false;
    }
  },

  isPersistent() {
    return persistent;
  },
};
