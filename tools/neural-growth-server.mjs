import http from "node:http";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const prototypeFile = (file, type) => [
  `prototypes/neural-growth/${file}`,
  type,
];
const publicFiles = new Map([
  ["/", prototypeFile("index.html", "text/html; charset=utf-8")],
  ["/index.html", prototypeFile("index.html", "text/html; charset=utf-8")],
  ["/styles.css", prototypeFile("styles.css", "text/css; charset=utf-8")],
  [
    "/controller.js",
    prototypeFile("controller.js", "text/javascript; charset=utf-8"),
  ],
  [
    "/runtime.js",
    prototypeFile("runtime.js", "text/javascript; charset=utf-8"),
  ],
  [
    "/reference.js",
    prototypeFile("reference.js", "text/javascript; charset=utf-8"),
  ],
  [
    "/assets/js/models/neural-growth/runtime.js",
    [
      "assets/js/models/neural-growth/runtime.js",
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/assets/js/models/neural-growth/reference.js",
    [
      "assets/js/models/neural-growth/reference.js",
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/checkpoint.json",
    ["models/neural-growth/checkpoint.json", "application/json; charset=utf-8"],
  ],
  [
    "/PROVENANCE.md",
    ["models/neural-growth/NOTICE.md", "text/plain; charset=utf-8"],
  ],
  [
    "/licenses/Apache-2.0.txt",
    ["licenses/neural-growth-Apache-2.0.txt", "text/plain; charset=utf-8"],
  ],
]);

function requestPath(url = "/") {
  const raw = url.split("?")[0];
  if (!raw.startsWith("/") || raw.includes("\\")) return null;
  const decoded = decodeURIComponent(raw);
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part.startsWith("."))
  )
    return null;
  return decoded;
}

export async function createNeuralGrowthServer(root = repositoryRoot) {
  const resolvedRoot = await realpath(root);
  const prototypePath = path.join(resolvedRoot, "prototypes", "neural-growth");
  const prototype = await realpath(prototypePath);
  if (prototype !== prototypePath)
    throw new Error("The prototype directory must not be a symlink.");
  if (!(await stat(path.join(prototype, "index.html"))).isFile())
    throw new Error("The Neural Growth prototype entry point is missing.");

  return http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response
          .writeHead(405, { Allow: "GET, HEAD" })
          .end("Method not allowed");
        return;
      }
      const pathname = requestPath(request.url);
      const entry = publicFiles.get(pathname);
      if (!entry) {
        response.writeHead(404).end("Not found");
        return;
      }
      const [relative, contentType] = entry;
      const filepath = path.join(resolvedRoot, relative);
      const resolvedFile = await realpath(filepath);
      const fileInfo = await lstat(filepath);
      if (resolvedFile !== filepath || !fileInfo.isFile()) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(filepath);
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  const port = Number(process.env.NEURAL_GROWTH_PORT || 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("NEURAL_GROWTH_PORT must be an integer from 1 to 65535.");
  const server = await createNeuralGrowthServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Neural Growth development prototype: http://127.0.0.1:${port}`,
    );
  });
}
