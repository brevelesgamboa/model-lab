import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "tools", "model-assets.json");

async function hashFile(relPath) {
  const fullPath = path.join(root, relPath);
  const bytes = await readFile(fullPath);
  return {
    path: relPath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
  const nonGrowth = existing.filter(
    (e) =>
      !e.path.startsWith("models/neural-growth/reference/") &&
      !e.path.startsWith("models/neural-growth/previews/"),
  );

  const referenceDir = path.join(root, "models", "neural-growth", "reference");
  const refFiles = (await readdir(referenceDir))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const previewsDir = path.join(root, "models", "neural-growth", "previews");
  const previewFiles = (await readdir(previewsDir))
    .filter((f) => f.endsWith(".png"))
    .sort();

  const newEntries = [];

  // Add reference checkpoints
  for (const f of refFiles) {
    const rel = `models/neural-growth/reference/${f}`;
    newEntries.push(await hashFile(rel));
  }

  // Add previews
  for (const f of previewFiles) {
    const rel = `models/neural-growth/previews/${f}`;
    newEntries.push(await hashFile(rel));
  }

  // Combine
  const combined = [...nonGrowth, ...newEntries];
  await writeFile(manifestPath, JSON.stringify(combined, null, 2) + "\n");
  console.log(
    `Updated ${manifestPath} with ${combined.length} assets (${newEntries.length} new growth assets).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
