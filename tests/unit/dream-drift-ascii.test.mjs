import test from "node:test";
import assert from "node:assert/strict";
import { createArchMesh } from "../../tools/dream-drift-ascii-renderer.mjs";

// Intersect a forward ray with a mesh, so the test checks the actual opening.
function hitCount(mesh, origin) {
  const { vertices, indices } = mesh;
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const direction = [0, 0, -1];
  let hits = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [...indices.slice(i, i + 3)].map((index) => [
      ...vertices.slice(index * 5, index * 5 + 3),
    ]);
    const e1 = sub(b, a),
      e2 = sub(c, a),
      p = cross(direction, e2),
      determinant = dot(e1, p);
    if (Math.abs(determinant) < 1e-9) continue;
    const t = sub(origin, a),
      u = dot(t, p) / determinant;
    const q = cross(t, e1),
      v = dot(direction, q) / determinant;
    const distance = dot(e2, q) / determinant;
    if (u >= 0 && v >= 0 && u + v <= 1 && distance > 0) hits++;
  }
  return hits;
}

test("arch meshes have a genuinely open center and solid uprights", () => {
  for (const radius of [1.45, 1.7]) {
    const mesh = createArchMesh({ z: -3, radius });
    for (const x of [-radius * 0.7, 0, radius * 0.7])
      assert.equal(hitCount(mesh, [x, 0, 0]), 0);
    for (const x of [-radius + 0.01, radius - 0.01])
      assert(hitCount(mesh, [x, 0, 0]) > 0);
    assert(hitCount(mesh, [0, 0.12 + radius - 0.01, 0]) > 0);
  }
});

test("swept arch triangles are finite, in bounds and have nonzero area", () => {
  const { vertices, indices } = createArchMesh();
  assert([...vertices].every(Number.isFinite));
  assert([...indices].every((i) => i * 5 + 4 < vertices.length));
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [...indices.slice(i, i + 3)].map((index) => [
      ...vertices.slice(index * 5, index * 5 + 3),
    ]);
    const p = b.map((v, j) => v - a[j]),
      q = c.map((v, j) => v - a[j]);
    const area = Math.hypot(
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    );
    assert(area > 1e-7);
    for (const v of [a, b, c]) assert(Math.abs(v[2] + 3) <= 0.045001);
  }
});
