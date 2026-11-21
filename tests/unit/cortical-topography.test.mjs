import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlaneMesh,
  OrbitCamera,
} from "../../assets/js/render/plane-mesh.js";
import {
  depthInputSize,
  imagenetRgb,
  normalizeDepth,
  blurredLuminance,
} from "../../assets/js/models/depth-data.js";
import {
  DepthEstimator,
  computeDepthTexture,
} from "../../assets/js/models/depth-estimator.js";
import { analyzePixels } from "../../assets/js/core/canvas-statistics.js";

test("shared canvas statistics retain solid-color and gradient behavior", () => {
  const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  const solid = analyzePixels(rgba, 16, 16);
  assert.ok(Math.abs(solid.signalMean - 1) < 1e-6);
  assert.ok(solid.signalDeviation < 1e-6);
  assert.equal(solid.chroma, 0);
  assert.equal(solid.edgeDensity, 0);
  assert.equal(solid.entropy, 0);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const value = x * 17;
      rgba.set([value, value, value, 255], (y * 16 + x) * 4);
    }
  const gradient = analyzePixels(rgba, 16, 16);
  assert.ok(Math.abs(gradient.signalMean - 0.5) < 1e-6);
  assert.ok(gradient.symmetryError > 0.5);
  assert.ok(gradient.complexity > 0.1);
});

test("the 256² plane covers its UV domain with bounded, consistently wound triangles", () => {
  const { vertices, indices } = createPlaneMesh();
  assert.equal(vertices.length, 65536 * 5);
  assert.equal(indices.length, 255 * 255 * 6);
  assert.deepEqual(Array.from(vertices.slice(0, 5)), [-1, -1, 0, 0, 0]);
  assert.deepEqual(Array.from(vertices.slice(-5)), [1, 1, 0, 1, 1]);
  let max = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    max = Math.max(max, a, b, c);
    const ab = [
      vertices[5 * b] - vertices[5 * a],
      vertices[5 * b + 1] - vertices[5 * a + 1],
    ];
    const ac = [
      vertices[5 * c] - vertices[5 * a],
      vertices[5 * c + 1] - vertices[5 * a + 1],
    ];
    assert.ok(ab[0] * ac[1] - ab[1] * ac[0] > 0);
  }
  assert.equal(max, 65535);
  assert.throws(() => createPlaneMesh(257), RangeError);
});

test("orbit matrices keep the target centered and stay finite at orbit/zoom/pan limits", () => {
  const camera = new OrbitCamera();
  for (const [dx, dy] of [
    [0, 0],
    [500, 2000],
    [-10000, -5000],
  ]) {
    camera.orbit(dx, dy);
    const { mvp } = camera.matrices(16 / 9);
    assert.ok(Array.from(mvp).every(Number.isFinite));
    const p = [...camera.target, 1];
    const transformed = Array.from({ length: 4 }, (_, row) =>
      p.reduce((sum, x, i) => sum + mvp[i * 4 + row] * x, 0),
    );
    assert.ok(Math.abs(transformed[0]) < 1e-5);
    assert.ok(Math.abs(transformed[1]) < 1e-5);
    assert.ok(transformed[3] > 0);
  }
  camera.zoom(-10000);
  assert.equal(camera.distance, 1.25);
  camera.zoom(10000);
  camera.zoom(10000);
  camera.zoom(10000);
  assert.equal(camera.distance, 12);
  camera.pan(1e6, 1e6, 1000);
  assert.ok(camera.target.every((x) => Math.abs(x) <= 4));
  camera.reset();
  assert.deepEqual(camera.target, [0, 0, 0.15]);
  assert.equal(camera.yaw, 0);
  assert.equal(camera.pitch, 0);
});

test("depth preprocessing preserves aspect on 14-pixel patches and uses checkpoint RGB normalization", () => {
  assert.deepEqual(depthInputSize(1000, 500), [518, 266]);
  assert.deepEqual(depthInputSize(500, 1000), [266, 518]);
  const input = imagenetRgb(new Uint8ClampedArray([255, 128, 0, 255]), 1, 1);
  assert.ok(Math.abs(input[0] - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs(input[1] - (128 / 255 - 0.456) / 0.224) < 1e-6);
  assert.ok(Math.abs(input[2] - -0.406 / 0.225) < 1e-6);
  assert.deepEqual(Array.from(normalizeDepth([2, 4, 6])), [0, 0.5, 1]);
  assert.deepEqual(Array.from(normalizeDepth([3, 3])), [0.5, 0.5]);
  assert.throws(() => normalizeDepth([NaN]), /non-finite/);
});

test("fallback depth blurs pixel noise into bounded, finite brightness relief", () => {
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const value = (x + y) % 2 ? 255 : 0;
      rgba.set([value, value, value, 255], (y * 32 + x) * 4);
    }
  const result = blurredLuminance(rgba, 32, 32);
  assert.ok(result.every((x) => Number.isFinite(x) && x >= 0 && x <= 1));
  assert.ok(Math.abs(result[16 * 32 + 16] - result[16 * 32 + 17]) < 0.01);
});

test("one-shot depth workers terminate after a result and reject stale captures/results", async () => {
  const workers = [];
  let release,
    closed = 0;
  const estimator = new DepthEstimator({
    capture: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    createWorker: () => {
      const worker = {
        postMessage() {},
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  const first = estimator.estimate({});
  const rejected = assert.rejects(first, { name: "AbortError" });
  await Promise.resolve();
  const releaseFirst = release;
  estimator.cancel();
  await rejected;
  releaseFirst({ close: () => closed++ });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(workers.length, 0);
  assert.equal(closed, 1);
  const second = estimator.estimate({});
  await Promise.resolve();
  release({ close() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = workers[0];
  const depth = new Float32Array([0, 1]);
  worker.onmessage({ data: { type: "result", width: 2, height: 1, depth } });
  assert.equal((await second).depth, depth);
  assert.equal(worker.terminated, true);
  assert.equal(estimator.pending, null);
  worker.onmessage({ data: { type: "error", error: "stale" } });
  assert.equal(estimator.pending, null);
  assert.equal(estimator.runs, 1);
});

test("depth upload exposes a usable preview immediately and keeps it after inference failure", async () => {
  const uploads = [];
  const gl = Object.fromEntries(
    ["bindTexture", "pixelStorei", "texParameteri"].map((key) => [
      key,
      () => {},
    ]),
  );
  gl.texImage2D = (...args) => uploads.push(args.at(-1));
  const fallback = {
    width: 2,
    height: 1,
    depth: new Float32Array([0, 1]),
    kind: "luminance",
  };
  let release,
    calls = 0,
    previewReady = false;
  const estimator = {
    estimate() {
      calls++;
      return new Promise((resolve) => (release = resolve));
    },
  };
  const result = computeDepthTexture(
    gl,
    {},
    {
      texture: {},
      fallback,
      estimator,
      onFallback: () => (previewReady = true),
    },
  );
  assert.equal(previewReady, true);
  assert.equal(uploads[0], fallback.depth);
  const depth = new Float32Array([1, 0]);
  release({ width: 2, height: 1, depth });
  assert.equal((await result).kind, "estimated");
  assert.equal(uploads[1], depth);
  assert.equal(calls, 1);
  const failed = await computeDepthTexture(
    gl,
    {},
    {
      texture: {},
      fallback,
      estimator: {
        estimate: async () => {
          throw new Error("offline");
        },
      },
    },
  );
  assert.equal(failed.kind, "luminance");
  assert.equal(failed.error, "offline");
  assert.equal(uploads.at(-1), fallback.depth);
});
