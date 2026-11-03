// Build the portable gateway demo from tracked code and caller-supplied assets.
// Generated images and self-contained HTML remain local under test-results/.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeDreamAsciiGallery(output, data) {
  const files = [
    "../assets/js/render/dome-mesh.js",
    "./dream-drift-ascii-renderer.mjs",
    "./dream-drift-ascii-viewer.mjs",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );
  const script = sources
    .map((source) =>
      source.replace(/^import .*;\n/gm, "").replaceAll("export ", ""),
    )
    .join("\n");
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  const template = await readFile(
    new URL("./dream-drift-ascii-gallery.html", import.meta.url),
    "utf8",
  );
  const marker = "<!-- DREAM_DRIFT_MODULE -->";
  if (template.split(marker).length !== 2)
    throw new Error("Expected one gallery module placeholder.");
  const html = template.replace(
    marker,
    () =>
      `<script type="module">\n${script}\nawait mountDreamAsciiViewer(${json});\n</script>`,
  );
  const file = path.join(output, "index.html");
  await writeFile(file, html);
  return file;
}
