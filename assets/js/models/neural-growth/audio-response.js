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

// Recovery has its own update-based budget; the small audio cap is unrelated.
export const RECOVERY_POLICY = Object.freeze({
  maximum: 2,
  updates: 64,
  dose: 16,
  radius: 0.15,
  meaningfulDose: 0.05,
});

// CPU intent only: every dose is interleaved with a real simulation update.
export class AudioResponse {
  constructor({ onRecoveryEvent = () => {} } = {}) {
    this.active = [];
    this.pointerDown = false;
    this.manualUntil = -Infinity;
    this.sequence = 0;
    this.revision = 0;
    this.emittedDose = 0;
    this.emittedMixingWeight = 0;
    this.lastCancellationReason = null;
    this.lastRejectionReason = null;
    this.onRecoveryEvent = onRecoveryEvent;
  }
  cancel(kind = "audio", reason = "cancelled") {
    const removed = [];
    this.active = this.active.filter((spore) => {
      const remove =
        kind === "all" ||
        (kind === "recovery" &&
          (spore.kind === "recovery" ||
            (spore.kind === "recovery-test" && reason !== "recovery-off")));
      if (remove) removed.push(spore);
      return !remove;
    });
    if (!removed.length) return;
    this.lastCancellationReason = reason;
    this.revision++;
    for (const attemptId of new Set(removed.map((s) => s.attemptId))) {
      this.onRecoveryEvent({
        type: "cancelled",
        attemptId,
        reason,
        timestamp: performance.now(),
      });
    }
  }
  interact(down, timestamp) {
    this.pointerDown = Boolean(down);
    this.manualUntil = timestamp + SPORE_POLICY.manualYield;
    this.cancel("all", down ? "pointer-held" : "manual-yield");
  }
  queueRecovery(
    timestamp,
    x,
    y,
    { test = false, attemptId = null, generation = null } = {},
  ) {
    this.lastRejectionReason = this.pointerDown
      ? "pointer-held"
      : timestamp < this.manualUntil
        ? "manual-yield"
        : this.active.length >= RECOVERY_POLICY.maximum
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
      generation,
      attemptId,
      kind: test ? "recovery-test" : "recovery",
      mode: "seed",
      updates: 0,
      emittedDose: 0,
      emittedMixingWeight: 0,
    });
    this.revision++;
    return true;
  }
  getDiagnostics(_timestamp, size) {
    const spores = this.active.map((spore) => ({
      x: spore.x,
      y: spore.y,
      mode: spore.mode,
      kind: spore.kind,
      attemptId: spore.attemptId,
      radius: Math.max(1, Math.round(RECOVERY_POLICY.radius * size)),
      remainingUpdates: RECOVERY_POLICY.updates - spore.updates,
      emittedDose: spore.emittedDose,
      emittedMixingWeight: spore.emittedMixingWeight,
      remainingEnvelopeDose: Math.max(
        0,
        RECOVERY_POLICY.dose - spore.emittedDose,
      ),
    }));
    return {
      activeSpores: spores.length,
      spores,
      rateCeiling:
        (RECOVERY_POLICY.dose * Math.PI) / (2 * RECOVERY_POLICY.updates),
      rateUnit: "per update",
      audioRateCeiling: SPORE_POLICY.rate,
      doseBudgetPerSpore: RECOVERY_POLICY.dose,
      emittedDose: this.emittedDose,
      emittedMixingWeight: this.emittedMixingWeight,
      remainingEnvelopeDose: spores.reduce(
        (sum, s) => sum + s.remainingEnvelopeDose,
        0,
      ),
      doseMeaning:
        "Optical mixing dose; alpha = 1-exp(-dose). Dispatch accounting, not measured GPU application after masks.",
      lastCancellationReason: this.lastCancellationReason,
      lastRejectionReason: this.lastRejectionReason,
    };
  }
  step(
    timestamp,
    size,
    disturb,
    dyeColor,
    { updates = 1, simulationSteps = 0 } = {},
  ) {
    if (!Number.isInteger(updates) || updates < 0 || updates > 128)
      throw new RangeError(
        "Recovery progress must be zero to 128 simulation updates.",
      );
    if (this.pointerDown || timestamp < this.manualUntil) return;
    for (let index = 0; index < updates; index++) {
      const completed = new Set();
      for (const spore of this.active) {
        const progress = Math.min(1, ++spore.updates / RECOVERY_POLICY.updates);
        const cumulative =
          (RECOVERY_POLICY.dose * (1 - Math.cos(Math.PI * progress))) / 2;
        const dose = cumulative - spore.emittedDose;
        if (!(dose > 0)) continue;
        const strength = -Math.expm1(-dose);
        disturb(
          Math.floor(spore.x * size),
          Math.floor(spore.y * size),
          Math.max(1, Math.round(RECOVERY_POLICY.radius * size)),
          spore.mode,
          {
            strength,
            dyeColor,
            lockBarrier: true,
            automatic: true,
            quantizationPhase: ++this.sequence,
          },
        );
        spore.emittedDose = cumulative;
        spore.emittedMixingWeight += strength;
        this.emittedDose += dose;
        this.emittedMixingWeight += strength;
        this.revision++;
        this.onRecoveryEvent({
          type: "dose",
          attemptId: spore.attemptId,
          dose,
          steps: simulationSteps + index + 1,
          timestamp,
        });
        if (spore.updates >= RECOVERY_POLICY.updates)
          completed.add(spore.attemptId);
      }
      this.active = this.active.filter(
        (s) => s.updates < RECOVERY_POLICY.updates,
      );
      for (const attemptId of completed)
        if (!this.active.some((s) => s.attemptId === attemptId)) {
          this.onRecoveryEvent({
            type: "delivered",
            attemptId,
            steps: simulationSteps + index + 1,
            timestamp,
          });
        }
    }
  }
}
