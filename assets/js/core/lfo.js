import { clamp } from "./utils.js";

export const LFO_WAVEFORMS = [
  { value: "sine", label: "SINE" },
  { value: "triangle", label: "TRIANGLE" },
  { value: "saw", label: "SAW" },
  { value: "square", label: "SQUARE" },
];

export function defaultLfoConfig() {
  return {
    enabled: false,
    waveform: "sine",
    rate: 0.05,
    depth: 0.2,
    phase: 0,
    polarity: "bipolar",
  };
}

function waveformValue(waveform, cycles) {
  const phase = cycles - Math.floor(cycles);
  switch (waveform) {
    case "triangle":
      return 1 - 4 * Math.abs(phase - 0.5);
    case "saw":
      return phase * 2 - 1;
    case "square":
      return phase < 0.5 ? 1 : -1;
    case "sine":
    default:
      return Math.sin(phase * Math.PI * 2);
  }
}

export function lfoPhaseAt(config, timeSeconds) {
  const cycles =
    timeSeconds * clamp(config.rate, 0.005, 8) + clamp(config.phase, 0, 1);
  return cycles - Math.floor(cycles);
}

export function lfoSignalAt(config, phase) {
  const value = waveformValue(config.waveform, phase);
  if (config.polarity === "positive") return (value + 1) * 0.5;
  if (config.polarity === "negative") return -(value + 1) * 0.5;
  return value;
}

export function rateFromPosition(position, maximum = 0.5) {
  return 0.005 * (maximum / 0.005) ** clamp(position, 0, 1);
}

export function positionFromRate(rate, maximum = 0.5) {
  return clamp(
    Math.log(clamp(rate, 0.005, maximum) / 0.005) / Math.log(maximum / 0.005),
    0,
    1,
  );
}

export function applyParameterBoundary(definition, value) {
  const min = Number(definition.min),
    max = Number(definition.max);
  return definition.wrap && max > min
    ? min + ((((Number(value) - min) % (max - min)) + max - min) % (max - min))
    : clamp(Number(value), min, max);
}

export function sanitizeLfoConfig(candidate = {}) {
  const defaults = defaultLfoConfig();
  const finite = (key, min, max) =>
    Number.isFinite(Number(candidate[key])) && candidate[key] !== null
      ? clamp(Number(candidate[key]), min, max)
      : defaults[key];
  return {
    enabled:
      candidate.enabled === undefined
        ? defaults.enabled
        : Boolean(candidate.enabled),
    waveform: LFO_WAVEFORMS.some(({ value }) => value === candidate.waveform)
      ? candidate.waveform
      : defaults.waveform,
    rate: finite("rate", 0.005, 8),
    depth: finite("depth", 0, 1),
    phase: finite("phase", 0, 1),
    polarity: ["positive", "negative"].includes(candidate.polarity)
      ? candidate.polarity
      : "bipolar",
  };
}

export function applyLfo(
  definition,
  baseValue,
  config,
  timeSeconds,
  bound = true,
) {
  if (!config?.enabled || definition.type !== "range") return Number(baseValue);
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  const modulation =
    lfoSignalAt(config, lfoPhaseAt(config, timeSeconds)) *
    clamp(config.depth, 0, 1) *
    range *
    0.5;
  return bound
    ? applyParameterBoundary(definition, Number(baseValue) + modulation)
    : Number(baseValue) + modulation;
}

export function hasActiveLfo(state) {
  return Object.values(state || {}).some((config) => Boolean(config?.enabled));
}
