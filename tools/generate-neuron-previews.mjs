// Regenerate the small feature-preview library from this app's exact checkpoint.
// Uses an isolated local server and the same generator as the manual explorer.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../server.mjs";
import {
  verifyModelAssets,
  inceptionCheckpointSha256,
} from "./model-assets.mjs";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node tools/generate-neuron-previews.mjs\nRegenerates the bundled InceptionV3 shortcut previews and asset hashes.\nRequires the prepared local model, TensorFlow.js assets, and Playwright Chromium.",
  );
  process.exit(0);
}

const root = new URL("../", import.meta.url);
const destination = new URL("models/inception/previews/", root);
await verifyModelAssets(fileURLToPath(root), { verifyPreviews: false });
const manifestUrl = new URL("tools/model-assets.json", root);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const graph = manifest.find(
  (entry) => entry.path === "models/inception/model.json",
);
const server = await createStaticServer(fileURLToPath(root));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let browser;
const images = [];
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.exposeFunction("previewProgress", (text) => console.log(text));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const neurons = await page.evaluate(
    async () =>
      (await import("/assets/js/models/neural-growth.js")).CURATED_NEURONS,
  );
  await page.evaluate(async () => {
    const { InceptionDreamModel } =
      await import("/assets/js/models/inception-dream.js");
    window.__previewLibraryOwner = new InceptionDreamModel();
    await window.__previewLibraryOwner.ensureModel();
  });
  for (const neuron of neurons) {
    images.push(
      await page.evaluate(async ({ layer, channel }) => {
        const { generateNeuronPreview } =
          await import("/assets/js/models/neural-growth/dream-guidance.js");
        const {
          previewSeed,
          NEURON_PREVIEW_RECIPE,
          NEURON_PREVIEW_SIZE,
          NEURON_PREVIEW_STEPS,
        } = await import("/assets/js/models/neural-growth/neuron-preview.js");
        const seed = previewSeed(layer, channel);
        await window.previewProgress(`Generating ${layer}:${channel}`);
        const url = await generateNeuronPreview(
          window.__previewLibraryOwner.model,
          layer,
          channel,
          NEURON_PREVIEW_SIZE,
          NEURON_PREVIEW_STEPS,
          {
            seed,
            onProgress: (step, total) => {
              if (step % 32 === 0)
                void window.previewProgress(
                  `${layer}:${channel}: ${step}/${total}`,
                );
            },
          },
        );
        return {
          layer,
          channel,
          seed,
          recipe: NEURON_PREVIEW_RECIPE,
          size: NEURON_PREVIEW_SIZE,
          steps: NEURON_PREVIEW_STEPS,
          url,
        };
      }, neuron),
    );
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

// Keep the current library intact until every preview finishes successfully.
const entries = images.map(({ url, ...entry }) => {
  if (!url.startsWith("data:image/webp;base64,"))
    throw new Error("The browser did not produce a WebP preview.");
  return { ...entry, file: `${entry.layer}-${entry.channel}.webp` };
});
await mkdir(destination, { recursive: true });
for (const [index, image] of images.entries()) {
  await writeFile(
    new URL(entries[index].file, destination),
    Buffer.from(image.url.split(",")[1], "base64"),
  );
}
await writeFile(
  new URL("catalog.json", destination),
  JSON.stringify(
    {
      schema: "inception-v3-preview-catalog-v1",
      model: "InceptionV3",
      modelSha256: graph.sha256,
      checkpointSha256: inceptionCheckpointSha256(manifest),
      recipe: entries[0].recipe,
      method:
        "Fourier image coordinates, color decorrelation, jitter and scale; generated from the bundled checkpoint",
      entries,
    },
    null,
    2,
  ) + "\n",
);
for (const file of [...entries.map((entry) => entry.file), "catalog.json"]) {
  const path = `models/inception/previews/${file}`;
  const bytes = await readFile(new URL(file, destination));
  const entry = {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const index = manifest.findIndex((item) => item.path === path);
  if (index < 0) manifest.push(entry);
  else manifest[index] = entry;
}
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Bundled ${entries.length} checkpoint-specific neuron previews.`);
