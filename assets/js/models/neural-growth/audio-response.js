import {
  audioMatrixForModel,
  restoreAudioMatrix,
} from "../../core/modulation-matrix.js";

export const AUDIO_PRESETS = Object.freeze([
  { value: "off", label: "Off", routes: {} },
  {
    value: "kick",
    label: "Kick",
    routes: {
      echoDecay: { source: "audioBeat", depth: 0.8, ceiling: 0.7 },
      palettePhase: { source: "audioBeat", depth: 0.18 },
    },
  },
]);

// Preset selection is an explicit UI action, never a saved-run hydration action.
export function applyAudioPreset(modelId, presetId, parameterKeys) {
  const matrix = audioMatrixForModel(modelId);
  for (const [key, route] of Object.entries(matrix))
    if (route.owner === "preset") delete matrix[key];
  const preset =
    AUDIO_PRESETS.find(({ value }) => value === presetId) || AUDIO_PRESETS[0];
  for (const [key, route] of Object.entries(preset.routes))
    if (!matrix[key]) matrix[key] = { ...route, owner: "preset" };
  restoreAudioMatrix(modelId, matrix, parameterKeys);
  return audioMatrixForModel(modelId);
}

export const SPORE_POLICY = Object.freeze({
  rate: 0.08,
  maximum: 2,
  lifetime: 400,
  radius: 0.03,
  manualYield: 2000,
});

// CPU intent only: GPU disturbances are drained by the model's simulation clock.
export class AudioResponse {
  constructor() {
    this.active = [];
    this.lastStep = null;
    this.pointerDown = false;
    this.manualUntil = -Infinity;
    this.sequence = 0;
  }
  cancel(kind = "audio") {
    this.active =
      kind === "all"
        ? []
        : this.active.filter((spore) => (spore.kind || "audio") !== kind);
    if (!this.active.length) this.lastStep = null;
  }
  interact(down, timestamp) {
    this.pointerDown = Boolean(down);
    this.manualUntil = timestamp + SPORE_POLICY.manualYield;
    this.cancel("all");
  }
  queueRecovery(timestamp, x, y) {
    this.active = this.active.filter(
      (spore) => timestamp - spore.start < SPORE_POLICY.lifetime,
    );
    if (
      this.pointerDown ||
      timestamp < this.manualUntil ||
      this.active.length >= SPORE_POLICY.maximum
    )
      return false;
    this.active.push({
      start: timestamp,
      x,
      y,
      amount: SPORE_POLICY.rate,
      kind: "recovery",
      mode: "noise",
    });
    if (this.lastStep === null) this.lastStep = timestamp;
    return true;
  }
  step(timestamp, size, disturb, dyeColor) {
    const previous = this.lastStep;
    this.lastStep = timestamp;
    if (previous === null || this.pointerDown || timestamp < this.manualUntil)
      return;
    const dt = Math.max(0, Math.min(0.05, (timestamp - previous) / 1000));
    this.active = this.active.filter(
      (spore) => timestamp - spore.start < SPORE_POLICY.lifetime,
    );
    const count = this.active.length;
    for (const spore of this.active) {
      const age = Math.max(
        0,
        (timestamp - spore.start) / SPORE_POLICY.lifetime,
      );
      const envelope = Math.sin(Math.PI * age);
      const strength = (spore.amount * dt * envelope) / count;
      if (!(strength > 0)) continue;
      disturb(
        Math.floor(spore.x * size),
        Math.floor(spore.y * size),
        Math.max(1, Math.round(SPORE_POLICY.radius * size)),
        spore.mode || "kick_color",
        {
          strength,
          dyeColor,
          lockBarrier: true,
          automatic: true,
          quantizationPhase: ++this.sequence,
        },
      );
    }
  }
}
