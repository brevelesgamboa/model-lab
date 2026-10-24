const NUM_BANDS = 32;
const DEFAULT_COOLDOWN_MS = 120;
const MAX_INJECTIONS_PER_FRAME = 3;

export const ACOUSTIC_INJECTION_MODES = Object.freeze([
  "off",
  "dye",
  "shockwave",
  "sprout",
  "flow",
]);

export const ACOUSTIC_POSITION_MODES = Object.freeze([
  "curve_peaks",
  "baseline",
  "center",
]);

export function colorForFrequencyBand(bandIndex, totalBands = NUM_BANDS) {
  const norm = Math.max(0, Math.min(1, bandIndex / (totalBands - 1)));
  if (norm < 0.25) return "#00f0ff"; // Sub-bass: Cyan
  if (norm < 0.55) return "#00ff66"; // Low-mids: Emerald
  if (norm < 0.8) return "#ffb800"; // High-mids: Gold
  return "#ff00a0"; // Treble: Magenta
}

export class AcousticEmitter {
  constructor(options = {}) {
    this.numBands = options.numBands || NUM_BANDS;
    this.cooldownMs = options.cooldownMs || DEFAULT_COOLDOWN_MS;

    this.runningAverages = new Float32Array(this.numBands);
    this.lastTriggerTimes = new Float32Array(this.numBands).fill(-9999);
    this.frequencyLut = null;
  }

  reset() {
    this.runningAverages.fill(0);
    this.lastTriggerTimes.fill(-9999);
  }

  buildFrequencyLut(sampleRate = 48000, fftSize = 2048) {
    const binWidth = sampleRate / fftSize;
    const minHz = 30;
    const maxHz = 12000;
    const ratio = maxHz / minHz;
    const lut = [];

    for (let i = 0; i < this.numBands; i += 1) {
      const f0 = minHz * ratio ** (i / this.numBands);
      const f1 = minHz * ratio ** ((i + 1) / this.numBands);
      const first = Math.max(0, Math.ceil(f0 / binWidth));
      const last = Math.min(1023, Math.max(first, Math.floor(f1 / binWidth)));
      const count = Math.max(1, last - first + 1);
      const weight = 1.0 + 0.6 * ((this.numBands - 1 - i) / (this.numBands - 1)) ** 2;
      lut.push({ first, last, count, weight });
    }
    this.frequencyLut = lut;
  }

  calculateGridCoordinates(bandIndex, level, positionMode, simulationSize, geometryCenter = [0, 0]) {
    const size = Math.max(16, simulationSize || 256);
    const u = (bandIndex + 0.5) / this.numBands;
    const gx = Math.round(u * (size - 1));

    if (positionMode === "center") {
      const [normCx, normCy] = geometryCenter;
      const mid = (size - 1) * 0.5;
      const cx = Math.round(mid + normCx * mid);
      const cy = Math.round(mid + normCy * mid);
      // Small radial scatter based on frequency band angle
      const angle = (bandIndex / this.numBands) * Math.PI * 2;
      const radius = Math.round(level * size * 0.15);
      return {
        x: Math.max(0, Math.min(size - 1, cx + Math.round(Math.cos(angle) * radius))),
        y: Math.max(0, Math.min(size - 1, cy + Math.round(Math.sin(angle) * radius))),
      };
    }

    if (positionMode === "baseline") {
      // Center line position (50% vertically)
      const gy = Math.round(0.50 * (size - 1));
      return { x: gx, y: gy };
    }

    // Default "curve_peaks": vertical position traces line height centered around 50%
    const v = 0.50 + (level - 0.5) * 0.25;
    const gy = Math.max(0, Math.min(size - 1, Math.round(v * (size - 1))));
    return { x: gx, y: gy };
  }

  process(spectrum, levels, timestamp, options = {}) {
    const mode = options.mode || "off";
    if (mode === "off" || !spectrum || spectrum.length === 0 || !levels?.hasSignal) {
      return 0;
    }

    if (!this.frequencyLut && options.rhythmController) {
      const sampleRate = options.rhythmController.context?.sampleRate || 48000;
      const fftSize = options.rhythmController.analyser?.fftSize || 2048;
      this.buildFrequencyLut(sampleRate, fftSize);
    }
    if (!this.frequencyLut) return 0;

    const threshold = Number(options.threshold ?? 0.45);
    const positionMode = options.position || "curve_peaks";
    const simulationSize = options.simulationSize || 256;
    const geometryCenter = options.geometryCenter || [0, 0];
    const baseRadius = Number(options.brushRadius) || Math.max(4, Math.round(simulationSize * 0.05));
    const queueDisturbance = options.queueDisturbance;
    if (typeof queueDisturbance !== "function") return 0;

    const lut = this.frequencyLut;
    const candidateBands = [];

    for (let b = 0; b < this.numBands; b += 1) {
      const entry = lut[b];
      let sum = 0;
      for (let i = entry.first; i <= entry.last; i += 1) {
        sum += spectrum[i];
      }
      const rawLevel = Math.max(0, Math.min(1.0, (sum / (entry.count * 255)) * entry.weight * 1.35));
      const runningAvg = this.runningAverages[b];
      const onset = rawLevel - runningAvg;

      // Update smoothed running average
      this.runningAverages[b] = runningAvg + (rawLevel - runningAvg) * 0.08;

      const elapsed = timestamp - this.lastTriggerTimes[b];
      if (onset > threshold && elapsed >= this.cooldownMs) {
        candidateBands.push({
          band: b,
          level: rawLevel,
          onset,
        });
      }
    }

    if (candidateBands.length === 0) return 0;

    // Sort by onset strength descending and limit to top transients
    candidateBands.sort((a, b) => b.onset - a.onset);
    const toDispatch = candidateBands.slice(0, MAX_INJECTIONS_PER_FRAME);

    for (let i = 0; i < toDispatch.length; i += 1) {
      const item = toDispatch[i];
      const b = item.band;
      this.lastTriggerTimes[b] = timestamp;

      const coords = this.calculateGridCoordinates(
        b,
        item.level,
        positionMode,
        simulationSize,
        geometryCenter,
      );

      const dynRadius = Math.max(
        2,
        Math.min(
          Math.floor(simulationSize * 0.15),
          Math.round(baseRadius * (0.6 + item.onset * 0.8)),
        ),
      );

      switch (mode) {
        case "dye":
          queueDisturbance(coords.x, coords.y, dynRadius, "dye", {
            dyeColor: colorForFrequencyBand(b, this.numBands),
            watercolor: true,
          });
          break;
        case "shockwave":
          queueDisturbance(coords.x, coords.y, dynRadius, "shockwave");
          break;
        case "sprout":
          queueDisturbance(coords.x, coords.y, Math.max(2, Math.round(dynRadius * 0.7)), "sprout", {
            organicSprout: true,
          });
          break;
        case "flow": {
          const angle = b < this.numBands / 2 ? -Math.PI * 0.35 : Math.PI * 0.35;
          queueDisturbance(coords.x, coords.y, dynRadius, "groom", {
            strokeAngle: angle,
          });
          break;
        }
      }
    }

    return toDispatch.length;
  }
}

