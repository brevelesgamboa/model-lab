export const PROFILES = {
  economy: {
    label: "ECONOMY / 384",
    size: 384,
    frameInterval: 16.7,
    analysisInterval: 420,
    gifSize: 224,
    gifFrames: 20,
  },
  standard: {
    label: "STANDARD / 512",
    size: 512,
    frameInterval: 8.3,
    analysisInterval: 300,
    gifSize: 256,
    gifFrames: 24,
  },
  high: {
    label: "HIGH / 768",
    size: 768,
    frameInterval: 8.3,
    analysisInterval: 380,
    gifSize: 320,
    gifFrames: 24,
  },
  ultra: {
    label: "ULTRA / 1024",
    size: 1024,
    frameInterval: 8.3,
    analysisInterval: 500,
    gifSize: 384,
    gifFrames: 24,
  },
  extreme: {
    label: "EXTREME / 1536",
    size: 1536,
    frameInterval: 12.0,
    analysisInterval: 700,
    gifSize: 448,
    gifFrames: 20,
  },
};

function detectMaxTextureSize() {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2", { powerPreference: "high-performance" }) ||
      canvas.getContext("webgl");
    if (!gl) return 2048;

    const texture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048;
    const renderbuffer =
      Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || texture;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [
      texture,
      texture,
    ];
    const limit = Math.min(
      texture,
      renderbuffer,
      Number(viewport[0]) || texture,
      Number(viewport[1]) || texture,
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return limit;
  } catch {
    return 2048;
  }
}

export function detectCapabilities() {
  const hasWebGPU = typeof navigator !== "undefined" && Boolean(navigator.gpu);
  return {
    threads: Number(globalThis.navigator?.hardwareConcurrency) || 2,
    memoryGb: Number(globalThis.navigator?.deviceMemory) || null,
    maxTextureSize: detectMaxTextureSize(),
    hasWebGPU,
  };
}

export function recommendedProfile(capabilities = detectCapabilities()) {
  const { threads, memoryGb, maxTextureSize } = capabilities;

  // API availability and texture limits do not measure GPU throughput.
  // Keep automatic preview conservative; higher resolutions remain explicit choices.
  if (
    maxTextureSize >= 2048 &&
    threads >= 8 &&
    (memoryGb === null || memoryGb >= 8)
  ) {
    return "high";
  }
  if (threads >= 2) return "standard";
  return "economy";
}

// Synchronous resolver so app.js gets the profile object immediately
export function resolveQuality(mode, capabilities = detectCapabilities()) {
  const selected = mode === "auto" ? recommendedProfile(capabilities) : mode;
  const profile = PROFILES[selected] || PROFILES.standard;
  const safeSize = Math.max(
    256,
    Math.min(profile.size, capabilities.maxTextureSize || profile.size),
  );

  return {
    ...profile,
    mode: selected,
    requestedMode: mode,
    size: safeSize,
    capabilities,
  };
}

export function qualityOptions() {
  return [
    { value: "auto", label: "AUTO / HARDWARE" },
    ...Object.entries(PROFILES).map(([value, profile]) => ({
      value,
      label: profile.label,
    })),
  ];
}
