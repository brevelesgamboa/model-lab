// Audio-reactive profiles for Neural Growth mapping to modulation routes.
// Presets populate standard modulationMatrixState routes without custom engines.

export const PROFILE_PARAMS = Object.freeze([
  "growthSpeed",
  "rotation",
  "twist",
]);

export const AUDIO_PROFILES = Object.freeze({
  off: Object.freeze({
    id: "off",
    label: "Off",
    description: "No automatic audio routes. Full manual control via parameter MOD panels.",
    base: Object.freeze({
      resonanceMode: "off",
      beatShockwave: "off",
    }),
    routes: Object.freeze({}),
  }),
  subtle: Object.freeze({
    id: "subtle",
    label: "Subtle",
    description: "Subtle kick pulses with an organic twist LFO and steady growth.",
    base: Object.freeze({
      growthSpeed: 60,
      rotation: 185,
      twist: 0,
      resonanceMode: "subtle",
      beatShockwave: "on",
      shockwaveIntensity: 0.25,
    }),
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "none", depth: 0.25 }),
      rotation: Object.freeze({ source: "kick", depth: 0.20 }),
      twist: Object.freeze({ source: "kick", depth: 0.01 }),
    }),
    lfos: Object.freeze({
      growthSpeed: Object.freeze({ enabled: false, waveform: "sine", rate: 0.1, depth: 0.2, phase: 0 }),
      rotation: Object.freeze({ enabled: false, waveform: "sine", rate: 0.05, depth: 0.80, phase: 0 }),
      twist: Object.freeze({ enabled: true, waveform: "sine", rate: 0.04, depth: 0.72, phase: 0 }),
    }),
  }),
  continuous: Object.freeze({
    id: "continuous",
    label: "Continuous",
    description: "Polyrhythmic LFO field with synchronized kick modulation across perception channels.",
    base: Object.freeze({
      growthSpeed: 100,
      rotation: 180,
      twist: 0,
      resonanceMode: "subtle",
      beatShockwave: "on",
      shockwaveIntensity: 0.35,
    }),
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "none", depth: 0.25 }),
      rotation: Object.freeze({ source: "kick", depth: 0.05 }),
      twist: Object.freeze({ source: "kick", depth: 0.05 }),
    }),
    lfos: Object.freeze({
      growthSpeed: Object.freeze({ enabled: false, waveform: "sine", rate: 0.1, depth: 0.2, phase: 0 }),
      rotation: Object.freeze({ enabled: true, waveform: "sine", rate: 0.05, depth: 1.00, phase: 0.50 }),
      twist: Object.freeze({ enabled: true, waveform: "sine", rate: 0.01, depth: 0.50, phase: 0 }),
    }),
  }),
  dynamic: Object.freeze({
    id: "dynamic",
    label: "Dynamic",
    description: "Energy-reactive field scaling between vibrant polyrhythms and a calm baseline.",
    base: Object.freeze({
      growthSpeed: 45,
      rotation: 180,
      twist: 0,
      resonanceMode: "full",
      beatShockwave: "on",
      shockwaveIntensity: 0.50,
    }),
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "none", depth: 0.25 }),
      rotation: Object.freeze({ source: "kick", depth: 0.10 }),
      twist: Object.freeze({ source: "kick", depth: 0.06 }),
    }),
    lfos: Object.freeze({
      growthSpeed: Object.freeze({ enabled: false, waveform: "sine", rate: 0.1, depth: 0.2, phase: 0 }),
      rotation: Object.freeze({ enabled: true, waveform: "sine", rate: 0.05, depth: 1.00, calmDepth: 0.12, phase: 0.50 }),
      twist: Object.freeze({ enabled: true, waveform: "sine", rate: 0.015, depth: 0.60, calmDepth: 0.08, phase: 0 }),
    }),
  }),
});

export const AUDIO_PROFILE_KEYS = Object.freeze(Object.keys(AUDIO_PROFILES));

export function matchesAudioProfile(profileId, context = {}) {
  const profile = AUDIO_PROFILES[profileId];
  if (!profile) return false;

  const matrix = context.matrix !== undefined ? context.matrix : context;
  const parameters = context.parameters;
  const lfoState = context.lfoState;

  // 1. Check audio routes
  for (const param of PROFILE_PARAMS) {
    const route = matrix?.[param] || { source: "none", depth: 0.25 };
    const expected = profile.routes?.[param] || { source: "none", depth: 0.25 };
    if (route.source !== expected.source) return false;
    if (expected.source !== "none") {
      if (Math.abs(Number(route.depth) - Number(expected.depth)) > 0.005) {
        return false;
      }
    }
  }

  if (matrix) {
    for (const [param, route] of Object.entries(matrix)) {
      if (!PROFILE_PARAMS.includes(param) && route?.source && route.source !== "none") {
        return false;
      }
    }
  }

  // 2. Check base parameters if provided and if profile has base specifications
  if (parameters && profile.base) {
    for (const [key, expectedVal] of Object.entries(profile.base)) {
      const currentVal = parameters[key];
      if (typeof expectedVal === "number") {
        if (Math.abs(Number(currentVal) - expectedVal) > 0.01) {
          return false;
        }
      } else if (String(currentVal) !== String(expectedVal)) {
        return false;
      }
    }
    // For Continuous and Dynamic, coordinateTransform must not be cartesian (switched to vortex or preserved other)
    if (
      (profileId === "continuous" || profileId === "dynamic") &&
      parameters.coordinateTransform === "cartesian"
    ) {
      return false;
    }
  }

  // 3. Check LFO settings if provided and if profile has lfo specifications
  if (lfoState && profile.lfos) {
    for (const [key, expectedLfo] of Object.entries(profile.lfos)) {
      const currentLfo = lfoState[key] || { enabled: false };
      const currentEnabled = Boolean(currentLfo.enabled);
      const expectedEnabled = Boolean(expectedLfo.enabled);
      if (currentEnabled !== expectedEnabled) {
        return false;
      }
      if (expectedEnabled) {
        if (currentLfo.polarity && currentLfo.polarity !== "bipolar") return false;
        if (Math.abs(Number(currentLfo.rate) - Number(expectedLfo.rate)) > 0.002) return false;
        if (Math.abs(Number(currentLfo.depth) - Number(expectedLfo.depth)) > 0.005) return false;
        if (Math.abs(Number(currentLfo.phase) - Number(expectedLfo.phase)) > 0.005) return false;
        if (currentLfo.waveform && currentLfo.waveform !== expectedLfo.waveform) return false;
      }
    }
  }

  return true;
}

export function detectAudioProfile(context = {}) {
  for (const key of ["subtle", "continuous", "dynamic"]) {
    if (matchesAudioProfile(key, context)) {
      return key;
    }
  }
  if (matchesAudioProfile("off", context)) {
    return "off";
  }
  return "custom";
}
