// Audio-reactive profiles for Neural Growth mapping to modulation routes.
// Presets populate standard modulationMatrixState routes without custom engines.

export const AUDIO_PROFILES = Object.freeze({
  off: Object.freeze({
    id: "off",
    label: "Off · Manual MOD",
    description: "No automatic audio routes. Full manual control via parameter MOD panels.",
    beatShockwave: "off",
    routes: Object.freeze({}),
  }),
  ambient: Object.freeze({
    id: "ambient",
    label: "Ambient · Sub-Bass Swell",
    description: "Gentle organic swelling of speed, relief depth, and light with music volume.",
    beatShockwave: "off",
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "bass", depth: 0.25 }),
      reliefStrength: Object.freeze({ source: "bass", depth: 0.2 }),
      lightAngle: Object.freeze({ source: "bass", depth: 0.15 }),
    }),
  }),
  rhythm: Object.freeze({
    id: "rhythm",
    label: "Rhythm · Beat Drive",
    description: "Punchy kick-driven speed pops and bass vector twist with center beat shockwaves.",
    beatShockwave: "center",
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "kick", depth: 0.4 }),
      twist: Object.freeze({ source: "bass", depth: 0.35 }),
      reliefStrength: Object.freeze({ source: "kick", depth: 0.3 }),
    }),
  }),
  dynamic: Object.freeze({
    id: "dynamic",
    label: "Dynamic · High Energy",
    description: "High-intensity audio reaction across speed, twist, relief, and lighting with interactive beat shockwaves.",
    beatShockwave: "pointer",
    routes: Object.freeze({
      growthSpeed: Object.freeze({ source: "kick", depth: 0.6 }),
      twist: Object.freeze({ source: "bass", depth: 0.55 }),
      lightAngle: Object.freeze({ source: "bass", depth: 0.5 }),
      reliefStrength: Object.freeze({ source: "kick", depth: 0.45 }),
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

export function matchesAudioProfile(profileId, matrix = {}, beatShockwave = "off") {
  const profile = AUDIO_PROFILES[profileId];
  if (!profile) return false;
  if (profile.beatShockwave !== beatShockwave) return false;

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

export function detectAudioProfile(matrix = {}, beatShockwave = "off") {
  for (const key of AUDIO_PROFILE_KEYS) {
    if (matchesAudioProfile(key, matrix, beatShockwave)) {
      return key;
    }
  }
  return "custom";
}

