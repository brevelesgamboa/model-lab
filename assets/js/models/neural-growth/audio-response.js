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
    this.revision = 0;
    this.emittedDose = 0;
    this.lastCancellationReason = null;
    this.lastRejectionReason = null;
  }
  cancel(kind = "audio", reason = "cancelled") {
    const before = this.active.length;
    this.active = this.active.filter((spore) => {
      if (kind === "all") return false;
      if (kind === "recovery" && spore.kind === "recovery-test")
        return reason === "recovery-off";
      return (spore.kind || "audio") !== kind;
    });
    if (!this.active.length) this.lastStep = null;
    if (before !== this.active.length) {
      this.lastCancellationReason = reason;
      this.revision++;
    }
  }
  interact(down, timestamp) {
    this.pointerDown = Boolean(down);
    this.manualUntil = timestamp + SPORE_POLICY.manualYield;
    this.cancel("all", down ? "pointer-held" : "manual-yield");
  }
  queueRecovery(timestamp, x, y, { test = false } = {}) {
    this.active = this.active.filter(
      (spore) => timestamp - spore.start < SPORE_POLICY.lifetime,
    );
    this.lastRejectionReason = this.pointerDown
      ? "pointer-held"
      : timestamp < this.manualUntil
        ? "manual-yield"
        : this.active.length >= SPORE_POLICY.maximum
          ? "spore-capacity"
          : null;
    if (this.lastRejectionReason) {
      this.revision++;
      return false;
    }
    this.active.push({
      start: timestamp,
      x,
      y,
      amount: SPORE_POLICY.rate,
      kind: test ? "recovery-test" : "recovery",
      mode: "noise",
      emittedDose: 0,
    });
    if (this.lastStep === null) this.lastStep = timestamp;
    this.revision++;
    return true;
  }
  getDiagnostics(timestamp, size) {
    const active = this.active.filter(
      (spore) => timestamp - spore.start < SPORE_POLICY.lifetime,
    );
    const spores = active.map((spore) => {
      const age = Math.max(
        0,
        Math.min(1, (timestamp - spore.start) / SPORE_POLICY.lifetime),
      );
      return {
        x: spore.x,
        y: spore.y,
        mode: spore.mode,
        kind: spore.kind,
        radius: Math.max(1, Math.round(SPORE_POLICY.radius * size)),
        remainingLifetimeMs: Math.max(
          0,
          SPORE_POLICY.lifetime - (timestamp - spore.start),
        ),
        emittedDose: spore.emittedDose,
        remainingEnvelopeDose:
          (spore.amount *
            (SPORE_POLICY.lifetime / 1000) *
            (1 + Math.cos(Math.PI * age))) /
          (Math.PI * active.length),
      };
    });
    return {
      activeSpores: spores.length,
      spores,
      rateCeiling: SPORE_POLICY.rate,
      emittedDose: this.emittedDose,
      remainingEnvelopeDose: spores.reduce(
        (sum, spore) => sum + spore.remainingEnvelopeDose,
        0,
      ),
      doseMeaning:
        "Requested mixing weight; remaining envelope is an estimate, not measured GPU application.",
      lastCancellationReason: this.lastCancellationReason,
      lastRejectionReason: this.lastRejectionReason,
    };
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
      spore.emittedDose += strength;
      this.emittedDose += strength;
      this.revision++;
    }
  }
}
