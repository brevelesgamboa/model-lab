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
    id: "dream",
    label: "Dream",
    keys: [
      "dreamEnabled",
      "dreamStrength",
      "dreamCadence",
      "targetLayer",
      "targetChannel",
      "dreamJitter",
      "dreamTvWeight",
      "dreamChroma",
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
    id: "simulation",
    label: "Simulation",
    keys: ["simulationSize", "topology"],
  },
]);
