const OLD_BRAND = ["unknown", "sight"].join("-");
export const QUALITY_STORAGE_KEY = "latent-field-quality-v1";
export const LEGACY_QUALITY_STORAGE_KEY = OLD_BRAND + "-quality-v4";
export const PANEL_STORAGE_KEY = "latent-field-panels-v1";
export const LEGACY_PANEL_STORAGE_KEY = OLD_BRAND + "-panels-v4";
export const FRACTAL_ROUTE_IDS = new Set(["folded-fractal"]);
export const FRACTAL_EXPLORE_ROUTE_IDS = new Set([
  ...FRACTAL_ROUTE_IDS,
  "fractal-functions",
]);
export const HQ_DB_NAME = "latent-field-hq-renders-v1";
export const HQ_STORE_NAME = "renders";

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
