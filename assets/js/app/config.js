export const OLD_BRAND = ["unknown", "sight"].join("-");
export const QUALITY_STORAGE_KEY = "latent-field-quality-v1";
export const LEGACY_QUALITY_STORAGE_KEY = OLD_BRAND + "-quality-v4";
export const PANEL_STORAGE_KEY = "latent-field-panels-v1";
export const LEGACY_PANEL_STORAGE_KEY = OLD_BRAND + "-panels-v4";
export const MOTION_SPEEDS = { slow: 0.38, normal: 0.82, fast: 1.65 };
export const FRACTAL_ROUTE_IDS = new Set(["folded-fractal"]);
export const FRACTAL_EXPLORE_ROUTE_IDS = new Set([
  ...FRACTAL_ROUTE_IDS,
  "fractal-functions",
]);
export const HQ_DB_NAME = "latent-field-hq-renders-v1";
export const HQ_STORE_NAME = "renders";
export const FRACTAL_PROCESS_COPY = {
  fold: "The coordinates mirror at the center, turning one shape into a balanced pair.",
  rotate:
    "Each pass turns the folded space, so the next symmetry lands at a new angle.",
  invert:
    "Near and far swap around a small radius, pulling fine detail out of simple coordinates.",
  translate:
    "The space shifts before the next pass, stopping every layer from stacking in the same place.",
  repeat:
    "The same short recipe runs again. Tiny parameter changes build a very different structure.",
};
export const LOOP_PRESETS = [
  { id: "off", name: "OFF", duration: 0 },
  { id: "orbit", name: "SLOW ORBIT", duration: 6 },
  { id: "pulse", name: "SOFT PULSE", duration: 4 },
  { id: "color", name: "COLOR CYCLE", duration: 5 },
  { id: "echo", name: "ECHO DRIFT", duration: 6 },
];

export const CLASSIC_FRACTAL_VIEWS = [
  {
    id: "mandelbrot-set",
    name: "MANDELBROT SET",
    parameters: {
      equation: 0,
      iterations: 180,
      zoomExponent: 0.15,
      centerX: -0.5,
      centerY: 0,
      paletteShift: 0.12,
      colorCycles: 5.2,
      orbitTrap: 0.42,
      drift: 0,
    },
  },
  {
    id: "seahorse-valley",
    name: "MANDELBROT · SEAHORSE VALLEY",
    parameters: {
      equation: 0,
      iterations: 380,
      zoomExponent: 3.05,
      centerX: -0.743643887,
      centerY: 0.1318259042,
      paletteShift: 0.16,
      colorCycles: 6.4,
      orbitTrap: 0.38,
      drift: 0,
    },
  },
  {
    id: "julia-dendrite",
    name: "JULIA · DENDRITE",
    parameters: {
      equation: 1,
      iterations: 220,
      zoomExponent: 0.2,
      centerX: 0,
      centerY: 0,
      juliaReal: -0.8,
      juliaImag: 0.156,
      paletteShift: 0.28,
      colorCycles: 5.6,
      orbitTrap: 0.48,
      drift: 0,
    },
  },
  {
    id: "tricorn-wing",
    name: "TRICORN · WING",
    parameters: {
      equation: 2,
      iterations: 280,
      zoomExponent: 1.75,
      centerX: -0.425,
      centerY: 0.575,
      paletteShift: 0.64,
      colorCycles: 6.2,
      orbitTrap: 0.44,
      drift: 0,
    },
  },
  {
    id: "burning-ship",
    name: "BURNING SHIP",
    parameters: {
      equation: 3,
      iterations: 360,
      zoomExponent: 2.9,
      centerX: -1.7443359375,
      centerY: -0.0174511719,
      paletteShift: 0.05,
      colorCycles: 6.8,
      orbitTrap: 0.35,
      drift: 0,
    },
  },
];
