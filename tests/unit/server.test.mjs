import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStaticServer } from "../../server.mjs";

test("static server serves public assets and rejects private and encoded paths", async (context) => {
  const server = await createStaticServer(new URL("../../", import.meta.url));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port;
  const response = await fetch(base + "/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  for (const target of [
    "/LICENSE",
    "/licenses/digiface-decoder-research.txt",
    "/models/digiface/NOTICE.txt",
  ]) {
    const licenseResponse = await fetch(base + target);
    assert.equal(licenseResponse.status, 200, target);
    assert.equal(
      licenseResponse.headers.get("content-type"),
      "text/plain; charset=utf-8",
      target,
    );
    assert.ok((await licenseResponse.text()).length > 0, target);
  }
  for (const target of [
    "/.git/config",
    "/%2egit/config",
    "/tools/check.mjs",
    "/%74ools/check.mjs",
    "/node_modules/package.json",
    "/models/classic-googlenet/deploy.prototxt",
    "/missing",
  ]) {
    assert.equal((await fetch(base + target)).status, 404, target);
  }
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  assert.equal((await fetch(base, { method: "HEAD" })).status, 200);
});
test("starting with a missing build fails explicitly", async () => {
  await assert.rejects(
    createStaticServer(new URL("../../missing-build/", import.meta.url)),
    /ENOENT/,
  );
});

test("the optional MI-GAN file supports HEAD and GET without exposing sibling model files", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "dome-server-"));
  await mkdir(path.join(root, "models/inpainting"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "test");
  await writeFile(
    path.join(root, "models/inpainting/migan_pipeline_v2.onnx"),
    new Uint8Array([1, 2, 3]),
  );
  await writeFile(path.join(root, "models/inpainting/private.txt"), "private");
  const server = await createStaticServer(root);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const url = base + "/models/inpainting/migan_pipeline_v2.onnx";
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "3");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.deepEqual(
    new Uint8Array(await (await fetch(url)).arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(
    (await fetch(base + "/models/inpainting/private.txt")).status,
    404,
  );
});
