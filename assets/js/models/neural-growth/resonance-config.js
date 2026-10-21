/*
 * SPDX-License-Identifier: Apache-2.0
 * Neural Growth Perturbation and Non-Linear Resonance Configuration
 */

export class ResonanceConfig {
  constructor({
    enabled = false,
    perceptionDrift = 0.0,
    perceptionPhase = 0.0,
    latentFeedback = 0.0,
    latentDecay = 1.0,
    noiseStrength = 0.0,
    activationWarp = 0.0,
    warpFrequency = 3.14159,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.perceptionDrift = Number.isFinite(Number(perceptionDrift))
      ? Math.max(-0.2, Math.min(0.2, Number(perceptionDrift)))
      : 0.0;
    this.perceptionPhase = Number.isFinite(Number(perceptionPhase))
      ? Number(perceptionPhase)
      : 0.0;
    this.latentFeedback = Number.isFinite(Number(latentFeedback))
      ? Math.max(0.0, Math.min(0.95, Number(latentFeedback)))
      : 0.0;
    this.latentDecay = Number.isFinite(Number(latentDecay))
      ? Math.max(0.5, Math.min(1.0, Number(latentDecay)))
      : 1.0;
    this.noiseStrength = Number.isFinite(Number(noiseStrength))
      ? Math.max(0.0, Math.min(0.5, Number(noiseStrength)))
      : 0.0;
    this.activationWarp = Number.isFinite(Number(activationWarp))
      ? Math.max(0.0, Math.min(1.0, Number(activationWarp)))
      : 0.0;
    this.warpFrequency = Number.isFinite(Number(warpFrequency))
      ? Math.max(0.1, Math.min(12.0, Number(warpFrequency)))
      : 3.14159;
  }

  toUniforms(stepCount = 0) {
    if (!this.enabled) {
      return {
        perceptionPhase: 0.0,
        latentFeedback: 0.0,
        latentDecay: 1.0,
        noiseStrength: 0.0,
        activationWarp: 0.0,
        warpFrequency: 3.14159,
        stepSeed: 0,
      };
    }
    const driftOffset = this.perceptionDrift * stepCount;
    return {
      perceptionPhase: this.perceptionPhase + driftOffset,
      latentFeedback: this.latentFeedback,
      latentDecay: this.latentDecay,
      noiseStrength: this.noiseStrength,
      activationWarp: this.activationWarp,
      warpFrequency: this.warpFrequency,
      stepSeed: (stepCount * 1664525 + 1013904223) >>> 0,
    };
  }
}

export const RESONANCE_PRESETS = Object.freeze({
  off: {
    enabled: false,
    perceptionDrift: 0.0,
    latentFeedback: 0.0,
    latentDecay: 1.0,
    noiseStrength: 0.0,
    activationWarp: 0.0,
  },
  drift: {
    enabled: true,
    perceptionDrift: 0.025,
    latentFeedback: 0.10,
    latentDecay: 0.98,
    noiseStrength: 0.0,
    activationWarp: 0.0,
  },
  feedback: {
    enabled: true,
    perceptionDrift: 0.0,
    latentFeedback: 0.40,
    latentDecay: 0.95,
    noiseStrength: 0.0,
    activationWarp: 0.0,
  },
  mutation: {
    enabled: true,
    perceptionDrift: 0.008,
    latentFeedback: 0.15,
    latentDecay: 0.97,
    noiseStrength: 0.05,
    activationWarp: 0.0,
  },
  crystal: {
    enabled: true,
    perceptionDrift: 0.0,
    latentFeedback: 0.20,
    latentDecay: 0.98,
    noiseStrength: 0.0,
    activationWarp: 0.35,
  },
});

