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
    rate: 0.1,
    depth: 0.2,
    phase: 0,
  };
}

export function waveformValue(waveform, cycles) {
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

export function applyLfo(definition, baseValue, config, timeSeconds) {
  if (!config?.enabled || definition.type !== "range") return Number(baseValue);
  const minimum = Number(definition.min);
  const maximum = Number(definition.max);
  const range = maximum - minimum;
  const cycles =
    timeSeconds * clamp(config.rate, 0.005, 8) + clamp(config.phase, 0, 1);
  const modulation =
    waveformValue(config.waveform, cycles) *
    clamp(config.depth, 0, 1) *
    range *
    0.5;
  return clamp(Number(baseValue) + modulation, minimum, maximum);
}

export function hasActiveLfo(state) {
  return Object.values(state || {}).some((config) => Boolean(config?.enabled));
}
