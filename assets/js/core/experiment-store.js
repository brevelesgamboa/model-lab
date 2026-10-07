const OLD_BRAND = ["unknown", "sight"].join("-");
const STORAGE_KEY = "latent-field-saved-runs-v1";
const LEGACY_KEYS = [
  `${OLD_BRAND}-saved-runs-v4`,
  `${OLD_BRAND}-experiments-v4`,
  `${OLD_BRAND}-experiments-v3`,
];
const MAX_RECORDS = 80;
let memoryRecords = [];
let persistent = true;

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  return {
    ...record,
    id: String(record.id || ""),
    createdAt: record.createdAt || new Date().toISOString(),
    note: String(record.note || "").slice(0, 160),
    parameters:
      record.parameters && typeof record.parameters === "object"
        ? record.parameters
        : {},
    effectiveParameters:
      record.effectiveParameters &&
      typeof record.effectiveParameters === "object"
        ? record.effectiveParameters
        : record.parameters && typeof record.parameters === "object"
          ? record.parameters
          : {},
    modulation:
      record.modulation && typeof record.modulation === "object"
        ? record.modulation
        : {},
    audioModulation:
      record.audioModulation && typeof record.audioModulation === "object"
        ? record.audioModulation
        : {},
    animationRunning: Boolean(record.animationRunning),
    guidedMotion:
      record.guidedMotion && typeof record.guidedMotion === "object"
        ? record.guidedMotion
        : {},
    anchors:
      record.anchors && typeof record.anchors === "object"
        ? record.anchors
        : null,
    metrics:
      record.metrics && typeof record.metrics === "object"
        ? record.metrics
        : {},
    modelMetrics:
      record.modelMetrics && typeof record.modelMetrics === "object"
        ? record.modelMetrics
        : {},
    thumbnail:
      typeof record.thumbnail === "string" &&
      record.thumbnail.startsWith("data:image/")
        ? record.thumbnail
        : "",
  };
}

function normalizeRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter(Boolean)
    .slice(0, MAX_RECORDS);
}

function readStoredRaw() {
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) return { raw: current, source: STORAGE_KEY };
  for (const key of LEGACY_KEYS) {
    const raw = window.localStorage.getItem(key);
    if (raw) return { raw, source: key };
  }
  return { raw: "", source: null };
}

function readRecords() {
  if (!persistent) return memoryRecords;
  try {
    const { raw, source } = readStoredRaw();
    const records = normalizeRecords(raw ? JSON.parse(raw) : []);
    if (source && source !== STORAGE_KEY) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    }
    memoryRecords = records;
    return records;
  } catch (error) {
    console.warn(
      "Saved-run storage is unavailable. Falling back to memory.",
      error,
    );
    persistent = false;
    return memoryRecords;
  }
}

function writeRecords(records) {
  const safeRecords = normalizeRecords(records);
  memoryRecords = safeRecords;
  if (!persistent) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safeRecords));
    LEGACY_KEYS.forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    console.warn(
      "Saved-run storage reached its limit. Keeping this session in memory.",
      error,
    );
    persistent = false;
  }
}

function nextRunId() {
  const maximum = readRecords().reduce((current, record) => {
    const match = String(record.id || "").match(/^RUN-(\d+)$/);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `RUN-${String(maximum + 1).padStart(6, "0")}`;
}

export const ExperimentStore = {
  getAll() {
    return readRecords();
  },

  get(id) {
    return readRecords().find((entry) => entry.id === id) || null;
  },

  add(record) {
    const complete = normalizeRecord({
      ...record,
      id: record.id || nextRunId(),
      createdAt: record.createdAt || new Date().toISOString(),
    });
    const records = readRecords();
    records.unshift(complete);
    writeRecords(records);
    return complete;
  },

  update(id, patch) {
    const records = readRecords();
    const index = records.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    records[index] = normalizeRecord({ ...records[index], ...patch });
    writeRecords(records);
    return records[index];
  },

  remove(id) {
    const records = readRecords();
    const next = records.filter((entry) => entry.id !== id);
    if (next.length === records.length) return false;
    writeRecords(next);
    return true;
  },

  clear() {
    writeRecords([]);
  },

  isPersistent() {
    return persistent;
  },

  sizeBytes() {
    try {
      return new Blob([JSON.stringify(readRecords())]).size;
    } catch {
      return JSON.stringify(readRecords()).length * 2;
    }
  },

  toCsv() {
    const header = [
      "run_id",
      "created_at",
      "model_id",
      "model_name",
      "model_family",
      "backend",
      "quality_mode",
      "quality_resolution",
      "frame_time_seconds",
      "seed",
      "visual_complexity",
      "entropy",
      "edge_density",
      "symmetry_error",
      "signal_mean",
      "chroma",
      "inference_ms",
      "note",
      "base_parameters_json",
      "effective_parameters_json",
      "lfo_json",
      "audio_modulation_json",
      "guided_motion_json",
      "anchors_json",
      "model_metrics_json",
    ];

    const rows = [header];
    readRecords().forEach((record) => {
      const metrics = record.metrics || {};
      rows.push([
        record.id,
        record.createdAt,
        record.modelId,
        record.modelName,
        record.modelFamily,
        record.backend,
        record.qualityMode ?? "",
        record.qualityResolution ?? "",
        record.frameTimeSeconds ?? record.parameters?.frameTimeSeconds ?? "",
        record.effectiveParameters?.seed ?? record.parameters?.seed ?? "",
        metrics.complexity ?? "",
        metrics.entropy ?? "",
        metrics.edgeDensity ?? "",
        metrics.symmetryError ?? "",
        metrics.signalMean ?? "",
        metrics.chroma ?? "",
        metrics.inferenceMs ?? "",
        record.note ?? "",
        JSON.stringify(record.parameters || {}),
        JSON.stringify(record.effectiveParameters || {}),
        JSON.stringify(record.modulation || {}),
        JSON.stringify(record.audioModulation || {}),
        JSON.stringify(record.guidedMotion || {}),
        JSON.stringify(record.anchors || {}),
        JSON.stringify(record.modelMetrics || {}),
      ]);
    });

    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return rows.map((row) => row.map(escape).join(",")).join("\n");
  },
};
