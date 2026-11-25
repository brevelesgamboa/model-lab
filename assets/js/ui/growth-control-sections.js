export const GROWTH_BRUSH_KEYS = Object.freeze([
  "brushRadius",
  "disturbanceMode",
  "dyeColor",
  "barrierOutline",
  "barrierLock",
]);

export const GROWTH_CONTROL_SECTIONS = Object.freeze([
  { id: "pattern", label: "Pattern", keys: ["pattern", "seed", "growthSpeed"] },
  {
    id: "geometry",
    label: "Geometry",
    keys: [
      "rotation",
      "coordinateTransform",
      "twist",
      "geometryStrength",
      "geometryCenterX",
      "geometryCenterY",
      "geometrySoftness",
      "foldCount",
    ],
  },
  {
    id: "temporal",
    label: "Temporal",
    keys: [
      "resonanceMode",
      "resonanceDrift",
      "resonanceFeedback",
      "resonanceNoise",
      "resonanceWarp",
      "latentMomentum",
      "echoDecay",
      "echoDrift",
      "echoMode",
      "echoStyle",
    ],
  },
  {
    id: "display",
    label: "Display",
    keys: [
      "zoom",
      "palette",
      "palettePhase",
      "paletteCycleSpeed",
      "channelView",
      "displayFilter",
    ],
  },
  {
    id: "audio",
    label: "Audio",
    keys: ["audioPreset"],
  },
  {
    id: "simulation",
    label: "Simulation",
    keys: ["simulationSize", "topology", "automaticRecovery"],
  },
]);
