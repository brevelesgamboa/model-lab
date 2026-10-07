import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTrainingServer } from "../../tools/train-neural-growth.mjs";

async function listen(context) {
  const server = createTrainingServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return server.address().port;
}

function request(port, target, method = "GET") {
  return new Promise((resolve, reject) => {
    const operation = http.request(
      { hostname: "127.0.0.1", port, path: target, method },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    operation.on("error", reject);
    operation.end();
  });
}

test("training server serves only explicit local development files", async (context) => {
  const port = await listen(context);
  for (const route of [
    "/",
    "/trainer.js",
    "/training-controller.js",
    "/target.png",
    "/assets/js/models/neural-growth/reference.js",
  ]) {
    const response = await request(port, route);
    assert.equal(response.status, 200, route);
    assert.ok(response.body.length > 0);
    assert.match(
      response.headers["content-security-policy"],
      /default-src 'self'/,
    );
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    const head = await request(port, route, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(
      head.headers["content-length"],
      response.headers["content-length"],
    );
  }
  assert.equal((await request(port, "/?pattern=membrane-field")).status, 200);
});

test("training server rejects private files, traversal, directory listings and writes", async (context) => {
  const port = await listen(context);
  for (const route of [
    "/.git/config",
    "/../package.json",
    "/%2e%2e/package.json",
    "/%252e%252e/package.json",
    "/trainer.js/../package.json",
    "/targets/",
    "/package.json",
    "/models/inception/model.json",
    "/tf.min.js%00",
  ]) {
    assert.equal((await request(port, route)).status, 404, route);
  }
  for (const method of ["POST", "PUT", "DELETE"])
    assert.equal((await request(port, "/target.png", method)).status, 405);
});

test("training target IDs cannot select arbitrary filesystem paths", () => {
  for (const id of [
    "../secrets",
    "",
    "mixed4c-439",
    "membrane-field/../private",
    null,
  ])
    assert.throws(() => createTrainingServer(id), /Unknown/);
});
