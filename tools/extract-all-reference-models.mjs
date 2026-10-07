import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeRgbaPng, upstream } from "./prepare-neural-growth.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scratchPath =
  "/home/sparky/.gemini/antigravity/brain/9d3413de-4467-4cfc-b604-61e501a92cc3/scratch/distill_models.json";
const outputDir = path.join(projectRoot, "models", "neural-growth", "reference");

const layerProfiles = [
  { shape: [49, 96], layout: [13, 6], scale: 2.0086004734039307 },
  { shape: [97, 12], layout: [65, 2], scale: 1.2275338172912598 },
];

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
  const sourceBytes = await (await import("node:fs/promises")).readFile(scratchPath);
  const bundle = JSON.parse(sourceBytes.toString("utf8"));
  console.log(`Processing ${bundle.model_names.length} models...`);

  const decodedLayers = layerProfiles.map((profile, i) => {
    const layer = bundle.layers[i];
    const [inputCount, outputCount] = profile.shape;
    const tileWidth = outputCount / 4;
    const width = tileWidth * profile.layout[0];
    const height = inputCount * profile.layout[1];
    const png = Buffer.from(layer.data.split(",")[1], "base64");
    return {
      pixels: decodeRgbaPng(png, width, height),
      width,
      profile,
      tileWidth,
      inputCount,
      outputCount,
    };
  });

  await mkdir(outputDir, { recursive: true });

  const manifestEntries = [];

  for (let modelIdx = 0; modelIdx < bundle.model_names.length; modelIdx++) {
    const rawName = bundle.model_names[modelIdx];
    const id = rawName.replace(/_/g, "-");
    const isTexture = modelIdx < 39;
    const readableName = rawName === "mixed4c_439" ? "Vesicle Study" : formatName(rawName);

    const layers = decodedLayers.map(
      ({ pixels, width, profile, tileWidth, inputCount, outputCount }) => {
        const originX = (modelIdx % profile.layout[0]) * tileWidth;
        const originY = Math.floor(modelIdx / profile.layout[0]) * inputCount;
        const weights = [];
        for (let row = 0; row < inputCount; row++) {
          const start = ((originY + row) * width + originX) * 4;
          weights.push(...pixels.subarray(start, start + outputCount));
        }
        return { shape: [...profile.shape], scale: profile.scale, weights };
      },
    );

    const checkpoint = {
      format: "latent-field-texture-nca-v1",
      id,
      name: readableName,
      source: {
        ...upstream,
        model: rawName,
        index: modelIdx,
        authors: [...upstream.authors],
      },
      layers,
    };

    const filePath = path.join(outputDir, `${id}.json`);
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    await writeFile(filePath, serialized);

    manifestEntries.push({
      id,
      rawName,
      name: readableName,
      pack: isTexture ? "Texture References" : "Inception References",
      category: isTexture ? "texture" : "inception",
      file: `models/neural-growth/reference/${id}.json`,
    });
  }

  console.log(`Extracted all ${manifestEntries.length} reference models to ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
