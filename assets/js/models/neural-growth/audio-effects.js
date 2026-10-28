// Retain the saved parameters and routes while these effects are being reworked.
export const NEURAL_GROWTH_AUDIO_EFFECTS = Object.freeze({
  audioReact: false,
  beatShockwave: false,
  audioCoupling: false,
  cameraBreath: false,
});

const EFFECT_CONTROLS = Object.freeze({
  audioProfile: "audioReact",
  beatShockwave: "beatShockwave",
  shockwaveIntensity: "beatShockwave",
  acousticInjection: "audioCoupling",
  acousticThreshold: "audioCoupling",
  acousticPosition: "audioCoupling",
  cameraBreathing: "cameraBreath",
  cameraReactivity: "cameraBreath",
});

export function isPausedAudioControl(key) {
  const effect = EFFECT_CONTROLS[key];
  return effect !== undefined && !NEURAL_GROWTH_AUDIO_EFFECTS[effect];
}
