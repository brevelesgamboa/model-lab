import {
  audioMatrixForModel,
  restoreAudioMatrix,
} from "../../core/modulation-matrix.js";

export const AUDIO_PRESETS = Object.freeze([
  { value: "off", label: "Off", routes: {} },
  {
    value: "kick-spore",
    label: "Kick & Spore",
    routes: {
      audioRippleAmount: { source: "audioBeat", depth: 0.9 },
      audioSporeAmount: { source: "audioBody", depth: 0.75 },
    },
  },
  {
    value: "bass-trails",
    label: "Bass Trails",
    routes: {
      echoDrift: { source: "audioBass", depth: 0.04 },
      echoDecay: { source: "audioActivity", depth: 0.8, ceiling: 0.7 },
    },
  },
  {
    value: "air-palette",
    label: "Air Palette",
    routes: {
      palettePhase: { source: "audioAir", depth: 0.18 },
      echoDecay: { source: "audioBody", depth: 0.4 },
    },
  },
  {
    value: "kick-ripple",
    label: "Kick Ripple",
    routes: { audioRippleAmount: { source: "audioBeat", depth: 0.4 } },
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
const unit = (value) => Math.max(0, Math.min(1, Number(value) || 0));

// CPU intent only: GPU disturbances are drained by the model's simulation clock.
export class AudioResponse {
  constructor() {
    this.generation = null;
    this.beatId = 0;
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
  update(levels, timestamp, parameters, enabled = true) {
    const changedSession = this.generation !== levels?.generation;
    if (changedSession) this.cancel();
    this.generation = levels?.generation;
    const id = Number(levels?.beatId) || 0;
    const fresh = !changedSession && id > this.beatId;
    this.beatId = changedSession ? id : Math.max(this.beatId, id);
    const allowed = enabled && levels?.hasSignal;
    if (!allowed) {
      this.cancel();
      return null;
    }
    this.active = this.active.filter(
      (spore) => timestamp - spore.start < SPORE_POLICY.lifetime,
    );
    if (
      !fresh ||
      !Number.isFinite(levels.onsetTimestamp) ||
      timestamp - levels.onsetTimestamp > 250 ||
      timestamp < levels.onsetTimestamp
    )
      return null;
    const strength = unit(levels.beatStrength);
    if (!(strength > 0)) return null;
    const values = typeof parameters === "function" ? parameters() : parameters;
    const ripple =
      Math.max(0, Math.min(1.5, Number(values.audioRippleAmount) || 0)) *
      strength;
    const amount = Math.max(
      0,
      Math.min(SPORE_POLICY.rate, Number(values.audioSporeAmount) || 0),
    );
    if (
      amount > 0 &&
      !this.pointerDown &&
      timestamp >= this.manualUntil &&
      this.active.length < SPORE_POLICY.maximum
    ) {
      this.sequence += 1;
      this.active.push({
        start: timestamp,
        kind: "audio",
        mode: "kick_color",
        amount: amount * strength,
        x: (this.sequence * 0.61803398875) % 1,
        y: (this.sequence * 0.41421356237) % 1,
      });
      if (this.lastStep === null) this.lastStep = timestamp;
    }
    return ripple > 0
      ? { ripple, x: (id * 0.61803398875) % 1, y: (id * 0.41421356237) % 1 }
      : null;
  }
  queueRecovery(timestamp, x, y) {
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
