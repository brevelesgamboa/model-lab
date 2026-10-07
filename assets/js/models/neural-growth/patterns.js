// Release catalog: only independently validated checkpoints belong here.
const commonInfo = {
  architecture:
    "12 state channels → 48 fixed-filter features → 96 ReLU units → 12 state deltas",
  inferenceFramework: "Native WebGL2 · quantized RGBA8",
  inferenceBackend: "WebGL2 required; half the cells update each step",
  browserInput: "Seeded update schedule; toroidal 128² or 256² grid",
  browserOutput: "RGB state projection; spectral palette is display-only",
};

function original(id, name) {
  return Object.freeze({
    id,
    name,
    pack: "Organic Structures",
    checkpointUrl: new URL(
      `../../../../models/neural-growth/organic-structures/${id}.json`,
      import.meta.url,
    ),
    technicalInfo: Object.freeze({
      ...commonInfo,
      title: `${name} · Organic Structures`,
      trainingSet:
        "Original AI-generated biological/alien texture; no real specimen data",
      objective:
        id === "membrane-field"
          ? "Multiscale fixed-feature Gram statistics and RGB moments; quantization-aware training from scratch"
          : "Multiscale fixed-feature Gram statistics, RGB correlation and spatial differences; quantization-aware training from scratch",
      trainingFramework: "TensorFlow.js WebGL · development only",
      trainingResolution: "32² state pool; 128² target",
      reference:
        "Texture NCA architecture; original target and newly trained dense weights",
      license:
        "Original checkpoint: project MIT terms · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/organic-structures/NOTICE.md",
    }),
  });
}

export const DEFAULT_PATTERN = "mixed4c-439";
export const PATTERNS = Object.freeze([
  Object.freeze({
    id: DEFAULT_PATTERN,
    name: "Vesicle Study",
    pack: "Published reference",
    checkpointUrl: new URL(
      "../../../../models/neural-growth/checkpoint.json",
      import.meta.url,
    ),
    technicalInfo: Object.freeze({
      ...commonInfo,
      title: "Vesicle Study · mixed4c_439",
      objective:
        "Published Inception v1 mixed4c channel 439 activation target (training only)",
      reference:
        "Niklasson, Mordvintsev, Randazzo & Levin · Self-Organising Textures (2021)",
      license: "Checkpoint: CC-BY-4.0 · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/NOTICE.md",
    }),
  }),
  original("membrane-field", "Membrane Field"),
  original("filament-network", "Filament Network"),
  original("xeno-reef", "Xeno Reef"),
]);

export function getPattern(id) {
  const pattern = PATTERNS.find((entry) => entry.id === id);
  if (!pattern) throw new Error(`Unknown Neural Growth pattern: ${id}`);
  return pattern;
}
