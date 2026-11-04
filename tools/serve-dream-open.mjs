import http from "node:http";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildOriginStudy, createOriginServer } from "./serve-dream-origin.mjs";
export async function buildOpenDrift(root) {
  await buildOriginStudy(root);
  const output = path.join(root, "test-results/dream-drift-open");
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "index.html"),
    await readFile(path.join(root, "tools/dream-open-gallery.html")),
  );
  return output;
}
export async function createOpenDriftServer(
  root,
  output = path.join(root, "test-results/dream-drift-open"),
) {
  const base = await createOriginServer(root),
    routes = new Map([
      ["/drift/", [path.join(output, "index.html"), "text/html"]],
    ]);
  for (const name of [
    "dream-open-viewer",
    "dream-open-field",
    "dream-open-content",
    "dream-open-shaders",
    "dream-origin-renderer",
    "dream-origin-shaders",
    "dream-origin-space",
    "dream-drift-ascii-renderer",
    "dream-world-content",
    "dream-world-map",
    "dream-world-storage",
    "dream-world-presets",
  ])
    routes.set(`/drift/${name}.mjs`, [
      path.join(root, "tools", `${name}.mjs`),
      "text/javascript",
    ]);
  for (const name of ["valley", "wetland", "folded"])
    routes.set(`/drift/landscapes/${name}.png`, [
      path.join(root, "experiments/dream-drift-open/landscapes", `${name}.png`),
      "image/png",
    ]);
  return http.createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const route = routes.get(pathname);
    if (!route) {
      base.emit("request", request, response);
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    try {
      const bytes = await readFile(route[0]);
      response
        .writeHead(200, {
          "Content-Type": route[1],
          "Content-Length": bytes.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404).end("Drift asset not available.");
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    output = await buildOpenDrift(root),
    server = await createOpenDriftServer(root, output);
  server.listen(Number(process.env.PORT || 8769), "127.0.0.1", () =>
    console.log(
      `Open Dream Drift: http://127.0.0.1:${server.address().port}/drift/`,
    ),
  );
}
