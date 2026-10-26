export const CAMERA_BREATHING_MODES = Object.freeze([
  "off",
  "subtle",
  "punchy",
  "drift",
]);

export class CameraMotionEngine {
  constructor() {
    this.kickPulse = 0.0;
    this.smoothBass = 0.0;
    this.driftPhase = 0.0;
    this.panX = 0.0;
    this.panY = 0.0;
    this.lastTimestamp = -1;
  }

  reset() {
    this.kickPulse = 0.0;
    this.smoothBass = 0.0;
    this.driftPhase = 0.0;
    this.panX = 0.0;
    this.panY = 0.0;
    this.lastTimestamp = -1;
  }

  update(levels, timestamp, parameters = {}) {
    const mode = parameters.cameraBreathing || "off";
    const strength = Math.max(
      0.1,
      Math.min(1.0, Number(parameters.cameraReactivity ?? 0.5)),
    );

    let dt = 0.016;
    if (this.lastTimestamp > 0 && timestamp > this.lastTimestamp) {
      dt = Math.min(0.5, Math.max(0.001, (timestamp - this.lastTimestamp) / 1000));
    }
    this.lastTimestamp = timestamp;

    if (mode === "off" || !levels || !levels.hasSignal) {
      // Smooth decay to rest on silence or mode off
      this.kickPulse *= Math.exp(-8.0 * dt);
      this.smoothBass *= Math.exp(-5.0 * dt);
      this.panX *= Math.exp(-6.0 * dt);
      this.panY *= Math.exp(-6.0 * dt);

      const isMoving =
        this.kickPulse > 0.001 ||
        this.smoothBass > 0.001 ||
        Math.abs(this.panX) > 0.0005 ||
        Math.abs(this.panY) > 0.0005;

      return {
        zoomOffset: this.kickPulse + this.smoothBass * 0.02,
        panX: this.panX,
        panY: this.panY,
        isMoving,
      };
    }

    // Process kick transients
    const kickOnset = Number(levels.kickOnset ?? levels.kick) || 0;
    let kPunch = 0.08;
    let maxPulse = 0.15;
    let kBreath = 0.035;

    if (mode === "subtle") {
      kPunch = 0.04;
      maxPulse = 0.07;
      kBreath = 0.02;
    } else if (mode === "punchy") {
      kPunch = 0.12;
      maxPulse = 0.20;
      kBreath = 0.03;
    } else if (mode === "drift") {
      kPunch = 0.06;
      maxPulse = 0.12;
      kBreath = 0.05;
    }

    if (kickOnset >= 0.50) {
      const onsetFrac = Math.min(1.0, (kickOnset - 0.5) / 0.5);
      const impulse = strength * kPunch * (0.5 + 0.5 * onsetFrac);
      this.kickPulse = Math.min(maxPulse, this.kickPulse + impulse);
    }

    // Exponential decay of kick pulse
    const decayLambda = mode === "punchy" ? 6.5 : 8.5;
    this.kickPulse *= Math.exp(-decayLambda * dt);

    // Continuous smoothed bass breathing
    const rawBass = Number(levels.bass) || 0;
    this.smoothBass += (rawBass - this.smoothBass) * Math.min(1.0, dt * 8.0);
    const breath = this.smoothBass * kBreath * strength;

    // Harmonic drift (subtle orbital camera pan)
    if (mode === "drift") {
      this.driftPhase += dt * 0.75;
      const panMax = 0.035 * strength;
      const targetPanX =
        Math.sin(this.driftPhase * 0.7) * panMax * (0.3 + 0.7 * this.smoothBass);
      const targetPanY =
        Math.cos(this.driftPhase * 0.5) *
        panMax *
        (0.3 + 0.7 * (Number(levels.activity) || rawBass));
      this.panX += (targetPanX - this.panX) * Math.min(1.0, dt * 6.0);
      this.panY += (targetPanY - this.panY) * Math.min(1.0, dt * 6.0);
    } else {
      this.panX *= Math.exp(-6.0 * dt);
      this.panY *= Math.exp(-6.0 * dt);
    }

    const zoomOffset = this.kickPulse + breath;
    const isMoving =
      zoomOffset > 0.001 ||
      Math.abs(this.panX) > 0.0005 ||
      Math.abs(this.panY) > 0.0005;

    return {
      zoomOffset,
      panX: this.panX,
      panY: this.panY,
      isMoving,
    };
  }
}
