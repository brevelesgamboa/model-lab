import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "model-assets.json",
);

export function inceptionCheckpointSha256(manifest) {
  const assets = manifest
    .filter(
      (entry) =>
        entry.path.startsWith("models/inception/") &&
        !entry.path.startsWith("models/inception/previews/"),
    )
    .map(({ path, sha256 }) => [path, sha256])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(assets)).digest("hex");
}

export async function verifyModelAssets(root, { verifyPreviews = true } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const entry of manifest) {
    if (!entry.path.startsWith("models/") || entry.path.includes(".."))
      throw new Error("Unsafe model manifest path.");
    const bytes = await readFile(path.join(root, entry.path));
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw new Error("Model integrity mismatch: " + entry.path);
    }
  }
  const graph = JSON.parse(
    await readFile(path.join(root, "models/inception/model.json"), "utf8"),
  );
  const recorded = new Set(manifest.map((entry) => entry.path));
  for (const group of graph.weightsManifest) {
    for (const shard of group.paths) {
      if (!recorded.has("models/inception/" + shard))
        throw new Error("Unrecorded Inception shard: " + shard);
    }
  }
  const previews = JSON.parse(
    await readFile(
      path.join(root, "models/inception/previews/catalog.json"),
      "utf8",
    ),
  );
  if (
    verifyPreviews &&
    previews.checkpointSha256 !== inceptionCheckpointSha256(manifest)
  )
    throw new Error(
      "Neuron preview checkpoint identity is stale; regenerate the preview library.",
    );
}
