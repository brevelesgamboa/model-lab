// Audio-reactive profiles for Neural Growth mapping to modulation routes.
// Presets populate standard modulationMatrixState routes without custom engines.

export const AUDIO_PROFILES = Object.freeze({
  off: Object.freeze({
    id: "off",
    label: "Off · Manual MOD",
    description: "No automatic audio routes. Full manual control via parameter MOD panels.",
    routes: Object.freeze({}),
  }),
  ambient: Object.freeze({
    id: "ambient",
    label: "Ambient · Sub-Bass Swell",
    description: "Gentle organic swelling of relief depth and lighting with sub-bass volume.",
    routes: Object.freeze({
      reliefStrength: Object.freeze({ source: "bass", depth: 0.25 }),
      lightAngle: Object.freeze({ source: "bass", depth: 0.15 }),
    }),
  }),
  rhythm: Object.freeze({
    id: "rhythm",
    label: "Rhythm · Beat Drive",
    description: "Punchy kick-driven relief pulses and subtle vector twist.",
    routes: Object.freeze({
      reliefStrength: Object.freeze({ source: "kick", depth: 0.35 }),
      twist: Object.freeze({ source: "bass", depth: 0.15 }),
    }),
  }),
  dynamic: Object.freeze({
    id: "dynamic",
    label: "Dynamic · High Energy",
    description: "High-intensity audio reaction across relief, lighting, and vector twist.",
    routes: Object.freeze({
      reliefStrength: Object.freeze({ source: "kick", depth: 0.45 }),
      lightAngle: Object.freeze({ source: "bass", depth: 0.3 }),
      twist: Object.freeze({ source: "bass", depth: 0.2 }),
    }),
  }),
});

export const AUDIO_PROFILE_KEYS = Object.freeze(Object.keys(AUDIO_PROFILES));

const MODULATION_PARAMS = Object.freeze([
  "growthSpeed",
  "twist",
  "lightAngle",
  "reliefStrength",
]);

export function matchesAudioProfile(profileId, matrix = {}) {
  const profile = AUDIO_PROFILES[profileId];
  if (!profile) return false;

  for (const param of MODULATION_PARAMS) {
    const route = matrix[param] || { source: "none", depth: 0.25 };
    const expected = profile.routes[param] || { source: "none", depth: 0.25 };
    if (route.source !== expected.source) return false;
    if (expected.source !== "none") {
      if (Math.abs(Number(route.depth) - Number(expected.depth)) > 0.005) {
        return false;
      }
    }
  }

  for (const [param, route] of Object.entries(matrix)) {
    if (!MODULATION_PARAMS.includes(param) && route?.source && route.source !== "none") {
      return false;
    }
  }
  return true;
}

export function detectAudioProfile(matrix = {}) {
  for (const key of AUDIO_PROFILE_KEYS) {
    if (matchesAudioProfile(key, matrix)) {
      return key;
    }
  }
  return "custom";
}

