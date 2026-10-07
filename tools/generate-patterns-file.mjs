import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const patternsFilePath = path.join(
  projectRoot,
  "assets",
  "js",
  "models",
  "neural-growth",
  "patterns.js",
);

function formatName(rawName) {
  if (rawName.startsWith("mixed")) {
    const parts = rawName.split("_");
    const layer = parts[0].replace("mixed", "");
    const ch = parts[1];
    return `Inception ${layer} (#${ch})`;
  }
  const parts = rawName.split("_");
  const base = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.length > 1 ? `${base} (${parts[1]})` : base;
}

async function main() {
  const scratchPath =
    "/home/sparky/.gemini/antigravity/brain/9d3413de-4467-4cfc-b604-61e501a92cc3/scratch/distill_models.json";
  const sourceBytes = await readFile(scratchPath);
  const bundle = JSON.parse(sourceBytes.toString("utf8"));

  const referenceEntries = bundle.model_names.map((rawName, index) => {
    const id = rawName.replace(/_/g, "-");
    const isTexture = index < 39;
    const name = rawName === "mixed4c_439" ? "Vesicle Study" : formatName(rawName);
    const pack = isTexture ? "Texture References" : "Inception References";
    const category = isTexture ? "texture" : "inception";
    const objective = isTexture
      ? "Pretrained VGG feature Gram matrix style loss (training only)"
      : `Published Inception v1 ${rawName.split("_")[0]} channel activation target (training only)`;
    const checkpointRelative =
      rawName === "mixed4c_439"
        ? "../../../../models/neural-growth/checkpoint.json"
        : `../../../../models/neural-growth/reference/${id}.json`;
    return {
      id,
      technicalId: rawName,
      name,
      pack,
      category,
      checkpointRelative,
      previewRelative: `../../../../models/neural-growth/previews/${id}.png`,
      title: `${name} · ${rawName}`,
      objective,
      reference: "Niklasson, Mordvintsev, Randazzo & Levin · Self-Organising Textures (2021)",
      license: "Checkpoint: CC-BY-4.0 · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/reference/NOTICE.md",
    };
  });

  const organicEntries = [
    {
      id: "membrane-field",
      technicalId: "membrane-field",
      name: "Membrane Field",
      pack: "Organic Structures",
      category: "organic",
      checkpointRelative: "../../../../models/neural-growth/organic-structures/membrane-field.json",
      previewRelative: "../../../../models/neural-growth/previews/membrane-field.png",
      title: "Membrane Field · Organic Structures",
      objective: "Multiscale fixed-feature Gram statistics and RGB moments; quantization-aware training from scratch",
      reference: "Texture NCA architecture; original target and newly trained dense weights",
      license: "Original checkpoint: project MIT terms · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/organic-structures/NOTICE.md",
    },
    {
      id: "filament-network",
      technicalId: "filament-network",
      name: "Filament Network",
      pack: "Organic Structures",
      category: "organic",
      checkpointRelative: "../../../../models/neural-growth/organic-structures/filament-network.json",
      previewRelative: "../../../../models/neural-growth/previews/filament-network.png",
      title: "Filament Network · Organic Structures",
      objective: "Multiscale fixed-feature Gram statistics, RGB correlation and spatial differences; quantization-aware training from scratch",
      reference: "Texture NCA architecture; original target and newly trained dense weights",
      license: "Original checkpoint: project MIT terms · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/organic-structures/NOTICE.md",
    },
    {
      id: "xeno-reef",
      technicalId: "xeno-reef",
      name: "Xeno Reef",
      pack: "Organic Structures",
      category: "organic",
      checkpointRelative: "../../../../models/neural-growth/organic-structures/xeno-reef.json",
      previewRelative: "../../../../models/neural-growth/previews/xeno-reef.png",
      title: "Xeno Reef · Organic Structures",
      objective: "Multiscale fixed-feature Gram statistics, RGB correlation and spatial differences; quantization-aware training from scratch",
      reference: "Texture NCA architecture; original target and newly trained dense weights",
      license: "Original checkpoint: project MIT terms · adapted runtime: Apache-2.0",
      provenanceUrl: "models/neural-growth/organic-structures/NOTICE.md",
    },
  ];

  // Put default Vesicle Study first, then organic, then rest of reference
  const defaultEntry = referenceEntries.find((e) => e.id === "mixed4c-439");
  const otherReferences = referenceEntries.filter((e) => e.id !== "mixed4c-439");
  const allEntries = [defaultEntry, ...organicEntries, ...otherReferences];

  let code = `// Release catalog: independently validated checkpoints with verified provenance.
const commonInfo = Object.freeze({
  architecture:
    "12 state channels → 48 fixed-filter features → 96 ReLU units → 12 state deltas",
  inferenceFramework: "Native WebGL2 · quantized RGBA8",
  inferenceBackend: "WebGL2 required; half the cells update each step",
  browserInput: "Seeded update schedule; toroidal 128² or 256² grid",
  browserOutput: "RGB state projection; spectral palette is display-only",
});

export const DEFAULT_PATTERN = "mixed4c-439";

export const PATTERNS = Object.freeze([\n`;

  for (const entry of allEntries) {
    code += `  Object.freeze({
    id: ${JSON.stringify(entry.id)},
    technicalId: ${JSON.stringify(entry.technicalId)},
    name: ${JSON.stringify(entry.name)},
    pack: ${JSON.stringify(entry.pack)},
    category: ${JSON.stringify(entry.category)},
    checkpointUrl: new URL(${JSON.stringify(entry.checkpointRelative)}, import.meta.url),
    previewUrl: new URL(${JSON.stringify(entry.previewRelative)}, import.meta.url),
    technicalInfo: Object.freeze({
      ...commonInfo,
      title: ${JSON.stringify(entry.title)},
      objective: ${JSON.stringify(entry.objective)},
      reference: ${JSON.stringify(entry.reference)},
      license: ${JSON.stringify(entry.license)},
      provenanceUrl: ${JSON.stringify(entry.provenanceUrl)},
    }),
  }),\n`;
  }

  code += `]);

export function getPattern(id) {
  const pattern = PATTERNS.find((entry) => entry.id === id);
  if (!pattern) throw new Error(\`Unknown Neural Growth pattern: \${id}\`);
  return pattern;
}
`;

  await writeFile(patternsFilePath, code);
  console.log(`Generated ${patternsFilePath} with ${allEntries.length} patterns.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
