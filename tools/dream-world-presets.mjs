const ranges = {
  depthScale: [0, 1.5],
  neuralSwell: [0, 1],
  waveMode: [0, 3],
  gain: [0, 1],
  frequency: [1, 30],
  speed: [0, 3],
  eccentricity: [0.005, 0.5],
  edgeCoupling: [0, 1],
  chromaticDispersion: [0, 1],
  cameraDolly: [-2, 2.5],
};
const settingRanges = { floor: [0, 1], negative: [0, 1] };
const booleans = ["digital", "fullHex", "portal"];
export const WORLD_PRESET_KEY = "latent-field:dream-world:looks:v1";
export function createWorldPreset(name, params, settings) {
  const value = {
    version: 1,
    name: String(name || "My dream look")
      .trim()
      .slice(0, 48),
    params: {},
    settings: {},
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const n = params[key];
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (key === "waveMode" && !Number.isInteger(n))
    )
      throw new RangeError("Invalid look parameter: " + key);
    value.params[key] = n;
  }
  for (const [key, [min, max]] of Object.entries(settingRanges)) {
    const n = settings[key];
    if (!Number.isFinite(n) || n < min || n > max)
      throw new RangeError("Invalid look setting: " + key);
    value.settings[key] = n;
  }
  for (const key of booleans) {
    if (typeof settings[key] !== "boolean")
      throw new RangeError("Invalid look setting: " + key);
    value.settings[key] = settings[key];
  }
  return value;
}
export function validateWorldPreset(value) {
  if (value?.version !== 1 || typeof value.name !== "string") return null;
  try {
    return createWorldPreset(value.name, value.params, value.settings);
  } catch {
    return null;
  }
}
export function loadWorldPresets(storage) {
  try {
    const raw = JSON.parse(storage.getItem(WORLD_PRESET_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.map(validateWorldPreset).filter(Boolean).slice(-10)
      : [];
  } catch {
    return [];
  }
}
export function storeWorldPreset(storage, value) {
  const valid = validateWorldPreset(value);
  if (!valid) throw new RangeError("Invalid dream look.");
  const all = loadWorldPresets(storage).filter((p) => p.name !== valid.name);
  all.push(valid);
  storage.setItem(WORLD_PRESET_KEY, JSON.stringify(all.slice(-10)));
  return all.slice(-10);
}
