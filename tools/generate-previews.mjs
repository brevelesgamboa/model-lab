import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PATTERNS } from "../assets/js/models/neural-growth/patterns.js";
import { validateCheckpoint } from "../assets/js/models/neural-growth/reference.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function packMatches(pattern, value) {
  const query = value.toLowerCase();
  return (
    pattern.pack.toLowerCase() === query ||
    path.basename(path.dirname(fileURLToPath(pattern.checkpointUrl))) === query
  );
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      pack: { type: "string", multiple: true },
      id: { type: "string", multiple: true },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node tools/generate-previews.mjs [--pack NAME] [--id ID] [--overwrite] [--dry-run]\n" +
        "Repeat --pack or --id to select several entries. Existing thumbnails are preserved unless --overwrite is set.",
    );
    return;
  }
  for (const id of values.id ?? []) {
    if (!PATTERNS.some((pattern) => pattern.id === id)) {
      throw new Error(`Unknown pattern: ${id}`);
    }
  }
  for (const pack of values.pack ?? []) {
    if (!PATTERNS.some((pattern) => packMatches(pattern, pack))) {
      throw new Error(`Unknown pack: ${pack}`);
    }
  }
  const selected = PATTERNS.filter(
    (pattern) =>
      (!values.id || values.id.includes(pattern.id)) &&
      (!values.pack || values.pack.some((pack) => packMatches(pattern, pack))),
  );
  if (selected.length === 0)
    throw new Error("No patterns match the selection.");
  const jobs = [];
  let skipped = 0;
  for (const pattern of selected) {
    const output = fileURLToPath(pattern.previewUrl);
    const present = await exists(output);
    const checkpoint = JSON.parse(
      await readFile(pattern.checkpointUrl, "utf8"),
    );
    const validated = validateCheckpoint(checkpoint);
    if (validated.id !== pattern.id) {
      throw new Error(`Checkpoint identity mismatch: ${pattern.id}`);
    }
    if (present && !values.overwrite) {
      skipped += 1;
      if (values["dry-run"])
        console.log(`[KEEP] ${pattern.id}: existing thumbnail`);
      continue;
    }
    jobs.push({ pattern, checkpoint, output });
    if (values["dry-run"]) {
      const { seed, seedState, gridSize, previewSteps } = validated.startup;
      console.log(
        `[PLAN] ${pattern.id}: ${gridSize}x${gridSize}, ${seedState}, seed ${seed}, ${previewSteps} steps`,
      );
    }
  }
  console.log(
    `Selected ${selected.length}; render ${jobs.length}; preserve ${skipped}.`,
  );
  if (values["dry-run"] || jobs.length === 0) return;

  // Browser execution is reached only for explicitly selected, missing previews
  // or when --overwrite is requested. A dry run never starts a browser.
  const { chromium } = await import("playwright");
  const { createStaticServer } = await import("../server.mjs");
  const server = await createStaticServer(projectRoot);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${server.address().port}/runtime-check.html`,
    );
    for (const { pattern, checkpoint, output } of jobs) {
      const dataUrl = await page.evaluate(async (raw) => {
        const { TextureNcaRuntime } =
          await import("/assets/js/models/neural-growth/runtime.js");
        const { validateCheckpoint } =
          await import("/assets/js/models/neural-growth/reference.js");
        const model = validateCheckpoint(raw);
        const runtime = new TextureNcaRuntime({ model });
        try {
          runtime.step(model.startup.previewSteps);
          const canvas = document.createElement("canvas");
          canvas.width = 128;
          canvas.height = 128;
          runtime.draw(canvas, "native", 1);
          return canvas.toDataURL("image/png");
        } finally {
          runtime.dispose();
        }
      }, checkpoint);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(
        output,
        Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
      );
      console.log(`[RENDERED] ${pattern.id}`);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
