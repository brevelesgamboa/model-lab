import test from "node:test";
import assert from "node:assert/strict";
import {
  createDomeMesh,
  DomeCamera,
} from "../../assets/js/render/dome-mesh.js";
import {
  FeatureHeatmapEstimator,
  computeFeatureHeatmap,
  validateFeatureTarget,
} from "../../assets/js/models/inception-feature-map.js";

test("the dome closes its seam and poles with nondegenerate inward triangles and 16-bit indices", () => {
  const { vertices: v, indices } = createDomeMesh();
  assert.equal(v.length, 65536 * 5);
  assert.equal(indices.length, 388620);
  for (let y = 0; y < 256; y++)
    assert.deepEqual(
      [...v.slice(y * 256 * 5, y * 256 * 5 + 3)],
      [...v.slice((y * 256 + 255) * 5, (y * 256 + 255) * 5 + 3)],
    );
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [...indices.slice(i, i + 3)].map((index) => [
      ...v.slice(index * 5, index * 5 + 3),
    ]);
    const ab = b.map((n, j) => n - a[j]),
      ac = c.map((n, j) => n - a[j]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    assert.ok(normal.reduce((sum, n, j) => sum + n * a[j], 0) < 0);
  }
  assert.throws(() => createDomeMesh(257), RangeError);
});

test("the first-person camera stays at the origin, looks through its center and clamps pitch at 89 degrees", () => {
  const camera = new DomeCamera();
  for (const delta of [
    [0, 0],
    [280, 100],
    [100000, 100000],
    [-100000, -100000],
  ]) {
    camera.look(...delta);
    const { view, projection, direction } = camera.matrices(1.5);
    assert.ok([...view, ...projection, ...direction].every(Number.isFinite));
    assert.deepEqual([...view.slice(12)], [0, 0, 0, 1]);
    assert.ok(Math.abs(camera.pitch) <= (89 * Math.PI) / 180);
    assert.ok(Math.abs(camera.yaw) <= Math.PI);
    const transformed = [0, 1, 2].map((row) =>
      direction.reduce((sum, n, col) => sum + view[col * 4 + row] * n, 0),
    );
    transformed.forEach((n, i) =>
      assert.ok(Math.abs(n - [0, 0, -1][i]) < 1e-6),
    );
  }
  camera.reset();
  assert.equal(camera.yaw, 0);
  assert.equal(camera.pitch, 0);
});

test("feature workers reject invalid targets, cancelled captures and replaced results, and release each worker", async () => {
  assert.throws(() => validateFeatureTarget("Mixed_5b", 120), RangeError);
  assert.throws(() => validateFeatureTarget("Conv2d_4a_3x3", 192), RangeError);
  const workers = [],
    captures = [];
  const estimator = new FeatureHeatmapEstimator({
    capture: () => new Promise((resolve) => captures.push(resolve)),
    createWorker: () => {
      const worker = {
        terminated: false,
        postMessage(data) {
          this.data = data;
        },
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  const first = estimator.estimate({}, "mixed_5b", 120);
  const rejectedFirst = assert.rejects(first, { name: "AbortError" });
  await Promise.resolve();
  const next = estimator.estimate({}, "mixed_6a", 42);
  await Promise.resolve();
  let closed = false;
  captures[0]({
    close() {
      closed = true;
    },
  });
  await rejectedFirst;
  await Promise.resolve();
  assert.equal(closed, true);
  captures[1]({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  workers[0].onmessage({
    data: {
      type: "result",
      width: 2,
      height: 2,
      values: new Float32Array([0, 1, 0.5, 0.2]),
    },
  });
  const result = await next;
  assert.equal(result.layer, "mixed_6a");
  assert.equal(result.channel, 42);
  assert.equal(workers[0].terminated, true);
  assert.equal(estimator.runs, 1);
  const abort = new AbortController();
  const third = estimator.estimate({}, "mixed_5b", 120, {
    signal: abort.signal,
  });
  const rejectedThird = assert.rejects(third, { name: "AbortError" });
  await Promise.resolve();
  captures[2]({ close() {} });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await rejectedThird;
  assert.equal(workers[1].terminated, true);
  assert.equal(estimator.pending, null);
});

test("heatmap textures use bilinear float storage, retain a flat map on failure and never upload an aborted result", async () => {
  const uploads = [],
    params = [];
  const gl = {
    TEXTURE_2D: 1,
    R16F: 2,
    RED: 3,
    FLOAT: 4,
    LINEAR: 5,
    CLAMP_TO_EDGE: 6,
    createTexture: () => ({}),
    bindTexture() {},
    pixelStorei() {},
    texParameteri(...args) {
      params.push(args);
    },
    texImage2D(...args) {
      uploads.push(args);
    },
  };
  const result = await computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
    estimator: {
      estimate: async () => ({
        width: 2,
        height: 2,
        values: new Float32Array([0, 0.25, 0.5, 1]),
        kind: "activation",
      }),
    },
  });
  assert.equal(result.kind, "activation");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1][2], gl.R16F);
  assert.ok(params.some((p) => p[2] === gl.LINEAR));
  const fallback = await computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
    estimator: {
      estimate: async () => {
        throw new Error("Offline");
      },
    },
  });
  assert.deepEqual([...fallback.values], [0]);
  assert.equal(fallback.error, "Offline");
  const abort = new AbortController();
  const before = uploads.length;
  await assert.rejects(
    computeFeatureHeatmap(gl, {}, "mixed_5b", 120, {
      signal: abort.signal,
      estimator: {
        estimate: async () => {
          abort.abort();
          return result;
        },
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(uploads.length, before + 1);
});
