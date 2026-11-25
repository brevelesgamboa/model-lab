// Suggested feature-preview starting points; channel meanings depend on the checkpoint.
export const CURATED_NEURONS = Object.freeze(
  [
    {
      id: "ensemble",
      name: "Full Ensemble",
      layer: "mixed_6c",
      channel: -1,
      desc: "All features at once: balanced, multi-scale dream patterns.",
    },
    {
      id: "curve",
      name: "Curve Detector",
      layer: "mixed_6c",
      channel: 144,
      desc: "Circular geometry: concentric rings, loops, and eye-like whorls.",
    },
    {
      id: "gabor",
      name: "Complex Gabor",
      layer: "mixed_6c",
      channel: 215,
      desc: "Directional waves: parallel ribs, arches, and flowing crests.",
    },
    {
      id: "compound",
      name: "Compound Texture",
      layer: "mixed_6a",
      channel: 82,
      desc: "Segmented tessellation: overlapping scales and armor-like plates.",
    },
    {
      id: "surround",
      name: "Center-Surround",
      layer: "mixed_5c",
      channel: 48,
      desc: "Radial pores: fine cellular foam, bubbles, and tiny vesicles.",
    },
    {
      id: "hatch",
      name: "Hatch Frequency",
      layer: "mixed_5b",
      channel: 120,
      desc: "Lattice grid: tight woven lines and orthogonal cross-hatching.",
    },
    {
      id: "semantic",
      name: "Semantic Parts",
      layer: "mixed_7b",
      channel: 312,
      desc: "Macro structures: high-order animal forms, limbs, and complex motifs.",
    },
  ].map(Object.freeze),
);
