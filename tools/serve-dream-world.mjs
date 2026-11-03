import http from "node:http";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildOriginStudy, createOriginServer } from "./serve-dream-origin.mjs";

export async function buildDreamWorld(
  root,
  output = path.join(root, "test-results/dream-drift-world"),
) {
  await buildOriginStudy(root);
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "index.html"),
    await readFile(path.join(root, "tools/dream-world-gallery.html")),
  );
  return output;
}
export async function createDreamWorldServer(
  root,
  output = path.join(root, "test-results/dream-drift-world"),
) {
  const base = await createOriginServer(root),
    routes = new Map([
      ["/world/", [path.join(output, "index.html"), "text/html"]],
      ["/world/index.html", [path.join(output, "index.html"), "text/html"]],
    ]);
  for (const name of [
    "dream-world-viewer",
    "dream-world-map",
    "dream-world-storage",
    "dream-world-content",
    "dream-world-presets",
    "dream-world-shaders",
    "dream-origin-renderer",
    "dream-origin-shaders",
    "dream-origin-space",
    "dream-drift-ascii-renderer",
  ])
    routes.set(`/world/${name}.mjs`, [
      path.join(root, "tools", name + ".mjs"),
      "text/javascript",
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
      const body = await readFile(route[0]);
      response
        .writeHead(200, {
          "Content-Type": route[1],
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end("World study not built.");
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    output = await buildDreamWorld(root),
    server = await createDreamWorldServer(root, output);
  server.listen(Number(process.env.PORT || 8768), "127.0.0.1", () =>
    console.log(
      `Dream Drift world: http://127.0.0.1:${server.address().port}/world/`,
    ),
  );
}
