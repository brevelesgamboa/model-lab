// Package the three supplied marmot studies as isolated, portable playable pages.
// node tools/build-dream-tunnel.mjs [output-folder] [cached-progression-folder]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildDreamTunnel(
  output = "test-results/dream-drift-tunnel",
  input = "test-results/dream-drift-neon-progression",
) {
  await mkdir(output, { recursive: true });
  const source = JSON.parse(
    await readFile(path.join(input, "report.json"), "utf8"),
  );
  if (source.status !== "complete")
    throw new Error("The saved panorama progression must be complete.");
  const files = [
    "../assets/js/render/dome-mesh.js",
    "./dream-drift-ascii-renderer.mjs",
    "./dream-tunnel-route.mjs",
    "./dream-tunnel-renderer.mjs",
    "./dream-tunnel-viewer.mjs",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );
  const script = sources
    .map((s) => s.replace(/^import[\s\S]*?;\n/gm, "").replaceAll("export ", ""))
    .join("\n");
  const template = await readFile(
    new URL("./dream-tunnel-gallery.html", import.meta.url),
    "utf8",
  );
  const marker = "<!-- DREAM_TUNNEL_MODULE -->";
  if (template.split(marker).length !== 2)
    throw new Error("Expected one tunnel module placeholder.");
  const texture = async (file) =>
    `data:image/png;base64,${(await readFile(path.join(input, file))).toString("base64")}`;
  for (let photo = 1; photo <= 3; photo++) {
    const entry = source.artifacts.find(
      (a) =>
        a.input === `photo-${photo}` &&
        a.experiment?.level === 6 &&
        a.experiment.variant === "neon" &&
        a.experiment.recipe === "mixed",
    );
    if (!entry)
      throw new Error(`Missing saved model metadata for photo ${photo}.`);
    const stages = [];
    for (let level = 0; level <= 6; level++)
      stages.push({
        natural: await texture(
          level
            ? `photo-${photo}-progression-mixed-${level}.png`
            : `photo-${photo}-migan.png`,
        ),
        neon: await texture(
          level
            ? `photo-${photo}-progression-mixed-${level}-neon.png`
            : `photo-${photo}-progression-baseline-neon.png`,
        ),
      });
    const data = JSON.stringify({
      photo,
      stages,
      head: entry.experiment.subjectRect,
    }).replaceAll("<", "\\u003c");
    const html = template.replace(
      marker,
      () =>
        `<script type="module">\n${script}\nawait mountDreamTunnelViewer(${data});\n</script>`,
    );
    await writeFile(
      path.join(output, photo === 3 ? "index.html" : `photo-${photo}.html`),
      html,
    );
  }
  return path.resolve(output, "index.html");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(await buildDreamTunnel(process.argv[2], process.argv[3]));
