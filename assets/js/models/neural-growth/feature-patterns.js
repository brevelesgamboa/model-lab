// Autonomous feature-trained checkpoints supplied with the geometry transfer bundle.
export const FEATURE_PATTERNS = Object.freeze(
  [
    {
      id: "feature-mixed4a-489",
      target: "mixed4a:489",
      name: "Ocular Iris (mixed4a:489)",
      description: "Autonomous concentric iris rings and eye whorls",
    },
    {
      id: "feature-mixed4c-439",
      target: "mixed4c:439",
      name: "Cellular Vesicle (mixed4c:439)",
      description: "Autonomous organic cell membranes and circular lumens",
    },
  ].map(({ id, target, name, description }) => {
    const previewUrl = new URL(
      `../../../../models/neural-growth/previews/${id}.gif`,
      import.meta.url,
    );
    return Object.freeze({
      id,
      technicalId: `${target.replace(":", "_")}_modeB`,
      name,
      description,
      target,
      pack: "Inception Archetypes",
      category: "inception",
      checkpointUrl: new URL(
        `../../../../models/neural-growth/features/${id}.json`,
        import.meta.url,
      ),
      previewUrl,
      previews: Object.freeze({
        fresh: previewUrl,
        grown: previewUrl,
        damage: new URL(
          `../../../../models/neural-growth/previews/${id}-damage.gif`,
          import.meta.url,
        ),
      }),
      startup: Object.freeze({
        seedState: "zeros",
        noiseStd: 0,
        seed: 1,
        gridSize: 128,
        previewSteps: 96,
      }),
      citation: Object.freeze({
        source: "Feature Visualization · Olah, Mordvintsev & Schubert (2017)",
        details: `Autonomous Mode B activation maximization against pre-ReLU Inception v1 ${target}`,
        license: "CC-BY-4.0",
      }),
      technicalInfo: Object.freeze({
        architecture:
          "12 state channels → 48 fixed-filter features → 96 ReLU units → 12 state deltas",
        inferenceFramework: "Native WebGL2 · quantized RGBA8",
        inferenceBackend: "WebGL2 required; half the cells update each step",
        browserInput: "Zero-state startup; seeded update schedule",
        browserOutput: description,
        title: name,
        objective: `Autonomous Mode B activation maximization against pre-ReLU Inception v1 ${target}`,
        reference:
          "Feature Visualization (2017) & Self-Organising Textures (2021)",
        license: "Checkpoint: CC-BY-4.0 · adapted runtime: Apache-2.0",
        provenanceUrl: "models/neural-growth/features/NOTICE.md",
      }),
    });
  }),
);
