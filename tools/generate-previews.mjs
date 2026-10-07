import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const previewsDir = path.join(projectRoot, "models", "neural-growth", "previews");
const referenceDir = path.join(projectRoot, "models", "neural-growth", "reference");
const organicDir = path.join(projectRoot, "models", "neural-growth", "organic-structures");

async function main() {
  await mkdir(previewsDir, { recursive: true });

  // Gather all model JSON paths
  const fs = await import("node:fs/promises");
  const referenceFiles = (await fs.readdir(referenceDir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.replace(".json", ""), path: path.join(referenceDir, f) }));
  
  const organicFiles = (await fs.readdir(organicDir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.replace(".json", ""), path: path.join(organicDir, f) }));

  const allModels = [...organicFiles, ...referenceFiles];
  console.log(`Found ${allModels.length} models to render previews for.`);

  // Start lightweight local server so Playwright can import runtime.js via ES modules
  const { createStaticServer } = await import("../server.mjs");
  const server = await createStaticServer(projectRoot);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log(`Ephemeral server listening on port ${port}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/runtime-check.html`);

    for (let i = 0; i < allModels.length; i++) {
      const { id, path: filePath } = allModels[i];
      const checkpointRaw = JSON.parse(await readFile(filePath, "utf8"));

      const dataUrl = await page.evaluate(
        async ({ checkpoint, steps }) => {
          const { TextureNcaRuntime } = await import(
            "/assets/js/models/neural-growth/runtime.js"
          );
          const { validateCheckpoint } = await import(
            "/assets/js/models/neural-growth/reference.js"
          );
          const size = 128;
          const validated = validateCheckpoint(checkpoint);
          const runtime = new TextureNcaRuntime({
            size,
            seed: 1,
            model: validated,
          });

          // Step 96 times to form the characteristic self-organized texture
          runtime.step(steps);

          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          runtime.draw(canvas, "native", 1);
          const url = canvas.toDataURL("image/png");
          runtime.dispose();
          return url;
        },
        { checkpoint: checkpointRaw, steps: 96 },
      );

      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
      const outPath = path.join(previewsDir, `${id}.png`);
      await writeFile(outPath, Buffer.from(base64Data, "base64"));
      process.stdout.write(`\rRendered ${i + 1}/${allModels.length}: ${id}`);
    }
    console.log(`\nSuccessfully rendered all ${allModels.length} previews to ${previewsDir}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("\nPreview generation error:", err);
  process.exit(1);
});
