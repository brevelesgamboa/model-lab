import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNeuralGrowthServer } from "../../tools/neural-growth-server.mjs";

const publicRoutes = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/controller.js", "controller.js", "text/javascript; charset=utf-8"],
  ["/runtime.js", "runtime.js", "text/javascript; charset=utf-8"],
  ["/reference.js", "reference.js", "text/javascript; charset=utf-8"],
  ["/checkpoint.json", "checkpoint.json", "application/json; charset=utf-8"],
  ["/PROVENANCE.md", "PROVENANCE.md", "text/plain; charset=utf-8"],
  [
    "/licenses/Apache-2.0.txt",
    "licenses/Apache-2.0.txt",
    "text/plain; charset=utf-8",
  ],
].map(([route, relative, mime]) => {
  const promoted = {
    "checkpoint.json": "models/neural-growth/checkpoint.json",
    "PROVENANCE.md": "models/neural-growth/NOTICE.md",
    "licenses/Apache-2.0.txt": "licenses/neural-growth-Apache-2.0.txt",
  };
  return [
    route,
    promoted[relative] || `prototypes/neural-growth/${relative}`,
    mime,
  ];
});
for (const file of ["runtime.js", "reference.js"]) {
  const relative = `assets/js/models/neural-growth/${file}`;
  publicRoutes.push([
    `/${relative}`,
    relative,
    "text/javascript; charset=utf-8",
  ]);
}

async function createFixture(context, { populate = true } = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "latent-field-nca-server-test-"),
  );
  // This exact, uniquely allocated fixture is the only recursively removed target.
  context.after(() => rm(root, { recursive: true, force: true }));
  const prototype = path.join(root, "prototypes", "neural-growth");
  if (populate) {
    for (const relative of new Set(publicRoutes.map(([, file]) => file))) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), `Fixture: ${relative}\n`);
    }
  }
  return { root, prototype };
}

async function listen(context, root) {
  const server = await createNeuralGrowthServer(root);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { port: server.address().port };
}

function requestRaw({ port }, target, method = "GET") {
  // URL/fetch normalization would hide literal and encoded dot-segment attacks.
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: target,
        method,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("Neural Growth server serves only exact public routes with MIME and security headers", async (context) => {
  const { root } = await createFixture(context);
  const server = await listen(context, root);
  for (const [route, relative, contentType] of publicRoutes) {
    const response = await requestRaw(server, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.body, `Fixture: ${relative}\n`, route);
    assert.equal(response.headers["content-type"], contentType, route);
    assert.equal(
      Number(response.headers["content-length"]),
      Buffer.byteLength(response.body),
      route,
    );
    assert.equal(response.headers["cache-control"], "no-store", route);
    assert.equal(response.headers["x-content-type-options"], "nosniff", route);
    assert.equal(response.headers["referrer-policy"], "no-referrer", route);
    const policy = response.headers["content-security-policy"];
    assert.match(policy, /default-src 'self'/, route);
    assert.match(policy, /script-src 'self'/, route);
    assert.match(policy, /object-src 'none'/, route);
    assert.match(policy, /base-uri 'none'/, route);
    assert.match(policy, /frame-ancestors 'none'/, route);
    assert.doesNotMatch(policy, /unsafe-(?:eval|inline)/, route);

    const head = await requestRaw(server, route, "HEAD");
    assert.equal(head.status, 200, route);
    assert.equal(head.body, "", route);
    assert.equal(
      head.headers["content-length"],
      response.headers["content-length"],
      route,
    );
    assert.equal(head.headers["content-type"], contentType, route);
    assert.equal(head.headers["content-security-policy"], policy, route);
  }
  assert.equal(
    (await requestRaw(server, "/index.html?cache=disabled")).status,
    200,
  );
  assert.equal((await requestRaw(server, "/%69ndex.html")).status, 200);
});

test("Neural Growth server rejects unlisted files and raw, encoded, and double-encoded attacks", async (context) => {
  const { root, prototype } = await createFixture(context);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "PRIVATE CONFIGURATION");
  await writeFile(path.join(root, "private.txt"), "PRIVATE ROOT FILE");
  await writeFile(
    path.join(prototype, "private.json"),
    "PRIVATE PROTOTYPE FILE",
  );
  const server = await listen(context, root);
  for (const target of [
    "/private.json",
    "/private.txt",
    "/.git/config",
    "/%2egit/config",
    "/%252egit/config",
    "/tools/neural-growth-server.mjs",
    "/assets/js/app.js",
    "/node_modules/package.json",
    "/prototypes/neural-growth/index.html",
    "/licenses/",
    "/runtime.js.map",
    "/missing",
    "/INDEX.html",
    "/index.html/",
    "//index.html",
    "/../index.html",
    "/x/../index.html",
    "/licenses/../index.html",
    "/%2e/index.html",
    "/%2e%2e/index.html",
    "/%2E%2E/index.html",
    "/%2e%2e%2findex.html",
    "/%252e%252e/index.html",
    "/index%252ehtml",
    "/\\index.html",
    "/..\\index.html",
    "/%5cindex.html",
    "/%2e%2e%5cindex.html",
    "/%00index.html",
    "/%ZZ",
  ]) {
    const response = await requestRaw(server, target);
    assert.equal(response.status, 404, target);
    assert.doesNotMatch(response.body, /PRIVATE/, target);
  }
});

test("Neural Growth server rejects methods other than GET and HEAD", async (context) => {
  const { root } = await createFixture(context);
  const server = await listen(context, root);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    const response = await requestRaw(server, "/", method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, "GET, HEAD", method);
  }
});

test("Neural Growth server rejects symlink files and directory escapes", async (context) => {
  const { root, prototype } = await createFixture(context);
  const secret = path.join(root, "secret.txt");
  await writeFile(secret, "PRIVATE SYMLINK TARGET");
  await unlink(path.join(prototype, "styles.css"));
  await symlink(secret, path.join(prototype, "styles.css"));
  await unlink(path.join(prototype, "runtime.js"));
  await symlink(
    path.join(prototype, "controller.js"),
    path.join(prototype, "runtime.js"),
  );
  await rename(
    path.join(root, "licenses"),
    path.join(root, "original-licenses"),
  );
  const outsideLicenses = path.join(root, "outside-licenses");
  await mkdir(outsideLicenses);
  await writeFile(
    path.join(outsideLicenses, "neural-growth-Apache-2.0.txt"),
    "PRIVATE DIRECTORY TARGET",
  );
  await symlink(outsideLicenses, path.join(root, "licenses"));
  const server = await listen(context, root);
  for (const target of [
    "/styles.css",
    "/runtime.js",
    "/licenses/Apache-2.0.txt",
  ]) {
    const response = await requestRaw(server, target);
    assert.equal(response.status, 403, target);
    assert.doesNotMatch(response.body, /PRIVATE/, target);
  }
  assert.equal((await requestRaw(server, "/index.html")).status, 200);
});

test("Neural Growth server rejects a symlink prototype directory", async (context) => {
  const { root, prototype } = await createFixture(context);
  const target = path.join(root, "prototype-target");
  await rename(prototype, target);
  await symlink(target, prototype);
  await assert.rejects(createNeuralGrowthServer(root), /must not be a symlink/);
});

test("Neural Growth server fails explicitly when its prototype or entry point is missing", async (context) => {
  const { root, prototype } = await createFixture(context, { populate: false });
  await assert.rejects(createNeuralGrowthServer(root), /ENOENT/);
  await mkdir(prototype, { recursive: true });
  await assert.rejects(createNeuralGrowthServer(root), /ENOENT/);
  await mkdir(path.join(prototype, "index.html"));
  await assert.rejects(
    createNeuralGrowthServer(root),
    /entry point is missing/,
  );
});
