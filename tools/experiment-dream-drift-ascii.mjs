// Cached-model ASCII + real mesh comparison. No inference or application edits.
// node tools/experiment-dream-drift-ascii.mjs [input-folder] [output-folder] [--gallery-only]
// --gallery-only rebuilds the live page without inference, captures or reports.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeDreamAsciiGallery } from "./dream-drift-ascii-gallery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const galleryOnly = process.argv.includes("--gallery-only");
const positional = process.argv.slice(2).filter((a) => a !== "--gallery-only");
const input = path.resolve(
  positional[0] || "test-results/dream-drift-neon-progression",
);
const output = path.resolve(
  positional[1] || "test-results/dream-drift-ascii-geometry",
);
// The full study now captures the current hex-rain presets and matching media.
if (!galleryOnly) {
  execFileSync(
    process.execPath,
    [path.join(root, "tools/experiment-dream-drift-hex.mjs"), output, input],
    { stdio: "inherit" },
  );
  process.exit(0);
}
await mkdir(output, { recursive: true });
const source = JSON.parse(
  await readFile(path.join(input, "report.json"), "utf8"),
);
assert.equal(source.status, "complete");
const embedded = new Map();
async function texture(file) {
  if (!embedded.has(file)) {
    const bytes = await readFile(path.join(input, file));
    embedded.set(file, `data:image/png;base64,${bytes.toString("base64")}`);
  }
  return file;
}
const scenes = [];
for (const entry of source.artifacts.filter(
  (a) =>
    a.experiment?.variant === "neon" &&
    a.experiment.recipe === "mixed" &&
    [3, 5, 6].includes(a.experiment.level),
)) {
  const e = entry.experiment,
    h = e.subjectRect;
  scenes.push({
    id: `${entry.input}-level-${e.level}`,
    input: entry.input,
    level: e.level,
    pitch: e.frontPitch,
    head: {
      x: h.x / 1024,
      y: h.y / 512,
      width: h.width / 1024,
      height: h.height / 512,
      featherX: h.feather / 1024,
      featherY: h.feather / 512,
    },
    neon: await texture(entry.texture),
    natural: await texture(`${entry.input}-progression-mixed-${e.level}.png`),
    seed: await texture(`${entry.input}-migan.png`),
  });
}
assert.equal(scenes.length, 9);
const galleryPath = await writeDreamAsciiGallery(output, {
  assets: Object.fromEntries(embedded),
  scenes,
});
console.log(`Built self-contained live gallery with ${scenes.length} scenes`);
if (galleryOnly) {
  console.log(galleryPath);
  process.exit(0);
}
