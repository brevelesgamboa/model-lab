// Dedicated loopback study: only explicit experiment paths and app assets.
import http from "node:http";
import path from "node:path";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../server.mjs";

export async function buildOriginStudy(
  root,
  output = path.join(root, "test-results/dream-drift-origin"),
) {
  await mkdir(output, { recursive: true });
  await copyFile(
    path.join(root, "tools/dream-origin-gallery.html"),
    path.join(output, "index.html"),
  );
  for (let n = 1; n <= 3; n++)
    await copyFile(
      path.join(
        root,
        `test-results/dream-drift-neon-progression/photo-${n}-source.png`,
      ),
      path.join(output, `source-photo-${n}.png`),
    );
  return output;
}
export async function createOriginServer(
  root,
  output = path.join(root, "test-results/dream-drift-origin"),
) {
  const base = await createStaticServer(root),
    routes = new Map([
      ["/origin/", [path.join(output, "index.html"), "text/html"]],
      ["/origin/index.html", [path.join(output, "index.html"), "text/html"]],
    ]);
  for (const name of [
    "dream-origin-viewer",
    "dream-origin-renderer",
    "dream-origin-shaders",
    "dream-origin-space",
    "dream-drift-ascii-renderer",
  ])
    routes.set(`/origin/${name}.mjs`, [
      path.join(root, "tools", name + ".mjs"),
      "text/javascript",
    ]);
  for (let n = 1; n <= 3; n++)
    routes.set(`/origin/source-photo-${n}.png`, [
      path.join(output, `source-photo-${n}.png`),
      "image/png",
    ]);
  for (const id of ["demo", "photo-1", "photo-2", "photo-3"])
    for (const stage of ["light", "deep"])
      routes.set(`/origin/studies/${id}/${stage}.png`, [
        path.join(output, "studies", id, stage + ".png"),
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
    if (pathname === "/origin/manifest.json") {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const studies = {};
      for (const id of ["demo", "photo-1", "photo-2", "photo-3"]) {
        try {
          studies[id] = JSON.parse(
            await readFile(
              path.join(output, "studies", id, "report.json"),
              "utf8",
            ),
          );
        } catch {}
      }
      const body = JSON.stringify({ studies });
      response
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(request.method === "HEAD" ? undefined : body);
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
      response.writeHead(404).end("Study not built.");
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    output = await buildOriginStudy(root),
    server = await createOriginServer(root, output);
  server.listen(Number(process.env.PORT || 8767), "127.0.0.1", () =>
    console.log(
      `Original dome study: http://127.0.0.1:${server.address().port}/origin/`,
    ),
  );
}
