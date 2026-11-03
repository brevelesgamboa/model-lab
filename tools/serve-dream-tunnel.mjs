// Dedicated loopback server for the experiment and existing local model assets.
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../server.mjs";

export async function createDreamTunnelServer(
  root,
  output = path.join(root, "test-results/dream-drift-tunnel"),
) {
  const base = await createStaticServer(root);
  const routes = new Map([
    ["/tunnel/", [path.join(output, "index.html"), "text/html; charset=utf-8"]],
    [
      "/tunnel/index.html",
      [path.join(output, "index.html"), "text/html; charset=utf-8"],
    ],
    ...[1, 2].map((i) => [
      `/tunnel/photo-${i}.html`,
      [path.join(output, `photo-${i}.html`), "text/html; charset=utf-8"],
    ]),
    [
      "/tunnel/progression.mjs",
      [
        path.join(root, "tools/dream-drift-progression.mjs"),
        "text/javascript; charset=utf-8",
      ],
    ],
  ]);
  return http.createServer(async (request, response) => {
    let route;
    try {
      route = routes.get(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
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
      response.writeHead(404).end("Build the tunnel study first.");
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = await createDreamTunnelServer(
    root,
    process.argv[2] ? path.resolve(process.argv[2]) : undefined,
  );
  server.listen(Number(process.env.PORT || 8766), "127.0.0.1", () =>
    console.log(
      `Dream tunnel: http://127.0.0.1:${server.address().port}/tunnel/`,
    ),
  );
}
