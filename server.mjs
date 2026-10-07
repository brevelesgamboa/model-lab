import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function isPublic(relative) {
  if (relative.split("/").some((part) => part.startsWith(".") || part === ".."))
    return false;
  if (relative.endsWith("/classic-dog-dream.js")) return false;
  return (
    [
      "index.html",
      "runtime-check.html",
      "build-info.json",
      "THIRD_PARTY_NOTICES.md",
      "LICENSE",
    ].includes(relative) ||
    [
      "assets/css/",
      "assets/js/",
      "assets/vendor/",
      "models/digiface/",
      "models/inception/",
      "models/neural-growth/",
      "licenses/",
    ].some((prefix) => relative.startsWith(prefix))
  );
}

export async function createStaticServer(directory) {
  const root = await realpath(directory);
  await stat(path.join(root, "index.html")); // A missing build is an error, not a silent source fallback.
  return http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response
          .writeHead(405, { Allow: "GET, HEAD" })
          .end("Method not allowed");
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url || "/", "http://localhost").pathname,
      );
      const relative =
        pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      if (!isPublic(relative)) {
        response.writeHead(404).end("Not found");
        return;
      }
      const filepath = await realpath(path.resolve(root, relative));
      const resolved = path.relative(root, filepath).split(path.sep).join("/");
      if (
        !isPublic(resolved) ||
        resolved.startsWith("../") ||
        path.isAbsolute(resolved)
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(filepath);
      response.writeHead(200, {
        "Content-Type":
          (relative === "LICENSE" && "text/plain; charset=utf-8") ||
          mimeTypes[path.extname(filepath).toLowerCase()] ||
          "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": body.length,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response
        .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Not found");
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    process.argv[2] || "dist",
  );
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "127.0.0.1";
  const server = await createStaticServer(root);
  server.listen(port, host, () => {
    console.log("LATENT FIELD serving " + root);
    console.log("Open http://" + host + ":" + server.address().port);
  });
}
