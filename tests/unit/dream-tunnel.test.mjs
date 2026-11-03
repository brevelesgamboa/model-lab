import test from "node:test";
import assert from "node:assert/strict";
import {
  DreamTunnelJourney,
  hilbertSite,
  tunnelSite,
  tunnelPath,
  tunnelFrame,
  tunnelProfile,
} from "../../tools/dream-tunnel-route.mjs";
import {
  createTunnelStrip,
  createTunnelArch,
  TUNNEL_FLOOR,
} from "../../tools/dream-tunnel-renderer.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const close = (a, b, tolerance = 1e-7) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("Hilbert tiles join by one cardinal step and reconstruct deterministically", () => {
  for (let n = 0; n < 4096; n++) {
    const a = hilbertSite(n),
      b = hilbertSite(n + 1);
    assert.equal(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 1);
    assert.deepEqual(a, hilbertSite(n));
  }
  assert.throws(() => hilbertSite(-1), RangeError);
});
test("route rebasing preserves global positions and continuous frames", () => {
  for (const node of [1, 2, 63, 64, 1000000]) {
    const a = tunnelPath(node - 0.000001, node - 1),
      b = tunnelPath(node + 0.000001, node),
      sa = tunnelSite(node - 1),
      sb = tunnelSite(node);
    close(a[0] + sa[0], b[0] + sb[0], 0.0001);
    close(a[1] + sa[1], b[1] + sb[1], 0.0001);
    const fa = tunnelFrame(node - 0.000001, node - 1),
      fb = tunnelFrame(node + 0.000001, node);
    close(fa.forward[0], fb.forward[0], 0.0001);
    close(fa.forward[1], fb.forward[1], 0.0001);
    close(fa.forward[0] * fa.right[0] + fa.forward[1] * fa.right[1], 0);
    assert.ok(Math.max(...b.map(Math.abs)) < 0.001);
  }
});
test("progression builds continuously and saturates without losing the floor", () => {
  let old = tunnelProfile(0);
  for (let p = 0.01; p < 100; p += 0.01) {
    const next = tunnelProfile(p);
    for (const key of [
      "hex",
      "neon",
      "corruption",
      "fractal",
      "echo",
      "model",
    ]) {
      assert.ok(next[key] >= old[key]);
      assert.ok(next[key] - old[key] < 0.02);
    }
    old = next;
  }
  assert.equal(tunnelProfile(0).hex, 0);
  assert.equal(tunnelProfile(3.5).hex, 1);
  assert.equal(tunnelProfile(3.5).neon, 1);
  assert.equal(tunnelProfile(1000000).model, 6);
  assert.ok(tunnelProfile(1000000).corruption <= 0.82);
  assert.equal(tunnelProfile(1000000).level, 5);
});
test("swept tunnel stays open and finite with a level floor at large route indices", () => {
  for (const node of [0, 2, 63, 64, 1000000])
    for (const floor of [false, true]) {
      const data = createTunnelStrip(node, node + 1, node, { floor });
      const count = data.vertices.length / 5;
      assert.ok(data.vertices.every(Number.isFinite));
      assert.ok(data.indices.every((i) => i < count));
      for (let i = 0; i < data.vertices.length; i += 5) {
        assert.ok(Math.abs(data.vertices[i]) < 24);
        assert.ok(Math.abs(data.vertices[i + 2]) < 24);
        if (floor) close(data.vertices[i + 1], TUNNEL_FLOOR, 0.000001);
      }
      // Every triangle spans two neighboring path rings: no end-cap wall exists.
      const ring = floor ? 2 : 35;
      for (let i = 0; i < data.indices.length; i += 3) {
        const rings = [...data.indices.slice(i, i + 3)].map((v) =>
          Math.floor(v / ring),
        );
        assert.equal(Math.max(...rings) - Math.min(...rings), 1);
      }
    }
});
test("all six gateway meshes have a clear passage wider than camera sidestep", () => {
  for (let style = 0; style < 6; style++) {
    const data = createTunnelArch(12.5, 12, style),
      f = data.frame;
    assert.ok(data.vertices.every(Number.isFinite));
    for (let i = 0; i < data.vertices.length; i += 5) {
      const x = data.vertices[i] - f.position[0],
        z = data.vertices[i + 2] - f.position[1],
        lateral = x * f.right[0] + z * f.right[1];
      if (data.vertices[i + 1] < 0.2) assert.ok(Math.abs(lateral) > 1.8);
    }
  }
});
test("loading gate holds until preparation and the settling fade both finish", async () => {
  let complete;
  const ready = [];
  const journey = new DreamTunnelJourney({
    prepare: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    onReady: (i, r) => ready.push([i, r]),
  });
  for (let i = 0; i < 200; i++) journey.update(0.1, 1);
  await flush();
  close(journey.parameter, 0.88);
  assert.equal(journey.snapshot().waiting, true);
  assert.equal(journey.snapshot().handoff, 0);
  complete("new image");
  await flush();
  assert.deepEqual(ready, [[1, "new image"]]);
  for (let i = 0; i < 5; i++) journey.update(0.1, 1);
  close(journey.parameter, 0.88);
  for (let i = 0; i < 20; i++) journey.update(0.1, 1);
  assert.ok(journey.parameter > 1);
});
test("failed preparation holds the gate and an explicit retry can recover", async () => {
  let attempts = 0;
  const journey = new DreamTunnelJourney({
    prepare: async () => {
      if (++attempts === 1) throw new Error("test failure");
      return null;
    },
  });
  journey.seek(0.87);
  await flush();
  journey.update(0.1, 1);
  assert.equal(journey.error, "test failure");
  close(journey.parameter, 0.88);
  journey.request(1);
  await flush();
  assert.equal(journey.error, null);
  for (let i = 0; i < 30; i++) journey.update(0.1, 1);
  assert.ok(journey.parameter > 1);
});
test("returning home aborts generation and ignores late output", async () => {
  let complete, signal;
  const results = [];
  const journey = new DreamTunnelJourney({
    prepare: (options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    onReady: (result) => results.push(result),
  });
  journey.seek(8.7);
  await flush();
  journey.home();
  assert.equal(signal.aborted, true);
  complete("stale image");
  await flush();
  assert.equal(journey.parameter, 0);
  assert.equal(journey.pending, null);
  assert.deepEqual(results, []);
});
test("movement clamps idle-tab time, sidestep and backwards entrance", () => {
  const journey = new DreamTunnelJourney();
  journey.update(1000, 1, 100);
  close(journey.parameter, (3 * 0.1) / 18);
  close(journey.lateral, 0.7);
  journey.update(0.1, -100, -100);
  assert.equal(journey.parameter, 0);
  close(journey.lateral, -0.7);
  assert.throws(() => journey.update(NaN), RangeError);
  assert.throws(() => journey.seek(-1), RangeError);
});
