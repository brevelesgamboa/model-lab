import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
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
