import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GEOMETRY_GLSL } from "../../assets/js/models/neural-growth/geometry-field.js";
import {
  geometryAngle,
  geometrySamples,
  circularMix,
  angleDistance,
  spiralSlope,
  secondSpin,
  voronoiNeighbors,
  juliaZero,
} from "../helpers/geometry-reference.mjs";

// These analytic contracts are also checked against the production GLSL by the
// GPU parity test in neural-growth-ui.spec.mjs (including all samples below).
test("geometry field contracts remain finite at every focal origin, corner and Strength", () => {
  for (const { pos, options, expected } of geometrySamples()) {
    assert.ok(Number.isFinite(expected), JSON.stringify({ pos, options }));
    assert.ok(
      Math.abs(Math.hypot(Math.cos(expected), Math.sin(expected)) - 1) < 1e-12,
    );
  }
  for (const mode of [1, 2, 6, 7])
    for (const softness of [0, 0.25, 1]) {
      const options = { mode, base: 0.7, softness };
      assert.equal(geometryAngle([0, 0], options), 0.7);
      for (const pos of [
        [1e-7, 0],
        [-1e-7, 0],
        [0, 1e-7],
        [0, -1e-7],
      ]) {
        assert.ok(angleDistance(geometryAngle(pos, options), 0.7) < 1e-7);
      }
    }
});

test("half Strength retains unit kernels and grooming takes the short arc through the pi seam", () => {
  const half = circularMix(0, Math.PI, 0.5);
  assert.ok(Math.abs(Math.cos(half)) < 1e-12);
  assert.ok(Math.abs(Math.sin(half)) > 0.999);
  const nearPi = circularMix(Math.PI - 0.01, -Math.PI + 0.01, 0.5);
  assert.ok(angleDistance(nearPi, Math.PI) < 1e-12);
  for (let i = 0; i <= 100; i++) {
    const a = circularMix(0.1, 0.1 + Math.PI, i / 100);
    assert.ok(Math.abs(Math.hypot(Math.cos(a), Math.sin(a)) - 1) < 1e-12);
  }
});

test("spiral extremes have bounded winding and a finite, continuous softened core", () => {
  assert.ok(Math.abs(spiralSlope((89 * Math.PI) / 180)) < 8);
  assert.ok(
    Math.abs(
      spiralSlope((35 * Math.PI) / 180) - Math.tan((35 * Math.PI) / 180),
    ) < 0.003,
  );
  for (const twist of [-Math.PI / 2, Math.PI / 2]) {
    const a = geometryAngle([0.2, 0.1], {
      mode: 2,
      twist,
      softness: 0,
      size: 128,
    });
    const b = geometryAngle([0.2 + 1e-6, 0.1], {
      mode: 2,
      twist,
      softness: 0,
      size: 128,
    });
    assert.ok(angleDistance(a, b) < 0.001);
  }
});

test("dipole poles circulate in opposite directions and pair Twist has no sign jump", () => {
  const left = geometryAngle([-0.45, 0.1], { mode: 4, softness: 0 });
  const right = geometryAngle([0.45, 0.1], { mode: 4, softness: 0 });
  assert.ok(Math.cos(left) < -0.9);
  assert.ok(Math.cos(right) > 0.9);
  assert.ok(
    angleDistance(
      geometryAngle([0, 0], { mode: 4, softness: 0 }),
      Math.PI / 2,
    ) < 1e-12,
  );
  assert.equal(secondSpin(0), 1);
  assert.ok(secondSpin(-0.35) < 0);
  assert.ok(Math.abs(secondSpin(-0.010001) - secondSpin(-0.009999)) < 0.0001);
  for (const twist of [-0.35, -0.175, -0.01, 0, 0.35]) {
    const a = geometryAngle([0.2, 0.4], { mode: 8, twist: twist - 1e-6 });
    const b = geometryAngle([0.2, 0.4], { mode: 8, twist: twist + 1e-6 });
    assert.ok(angleDistance(a, b) < 0.001);
  }
});

test("kaleidoscope mirror boundaries are continuous for every supported fold count", () => {
  for (let folds = 3; folds <= 12; folds++)
    for (let i = -2 * folds; i <= 2 * folds; i++) {
      const phi = (i * Math.PI) / folds;
      const at = (p) =>
        geometryAngle([0.7 * Math.cos(p), 0.7 * Math.sin(p)], {
          mode: 7,
          folds,
        });
      assert.ok(
        angleDistance(at(phi - 1e-7), at(phi + 1e-7)) < 1e-5,
        `folds=${folds}, sector=${i}`,
      );
    }
});

test("Voronoi shared wall tangents survive nearest-site exchanges at every Twist", () => {
  const a = [0.5, 0.5],
    b = [1.5 + 0.38 * Math.sin(127.1), 0.5 + 0.38 * Math.sin(269.5)];
  for (const softness of [0, 0.25, 1]) {
    const scale = 2.2 + 2 * softness;
    const mid = [(a[0] + b[0]) / (2 * scale), (a[1] + b[1]) / (2 * scale)];
    const dx = (b[0] - a[0]) * 1e-6,
      dy = (b[1] - a[1]) * 1e-6;
    const l = [mid[0] - dx, mid[1] - dy],
      r = [mid[0] + dx, mid[1] + dy];
    assert.notEqual(
      voronoiNeighbors(l, softness)[0].id,
      voronoiNeighbors(r, softness)[0].id,
    );
    for (const twist of [-Math.PI / 2, 0, Math.PI / 2]) {
      assert.ok(
        angleDistance(
          geometryAngle(l, { mode: 9, softness, twist }),
          geometryAngle(r, { mode: 9, softness, twist }),
        ) < 1e-5,
      );
    }
  }
});

test("production shaders share geometry and isolate atan behind finite zero-vector guards", async () => {
  const source = await readFile(
    new URL("../../assets/js/models/neural-growth/runtime.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.split("${GEOMETRY_GLSL}").length - 1, 2);
  assert.equal((GEOMETRY_GLSL.match(/atan\(/g) || []).length, 1);
  assert.match(
    GEOMETRY_GLSL,
    /any\(isnan\(direction\)\).*any\(isinf\(direction\)\).*dot\(direction, direction\) < 1e-12/,
  );
  assert.doesNotMatch(source, /\batan\(|\bnormalize\(/);
  assert.doesNotMatch(source, /smoothstep\(u_radius,/);
  assert.match(GEOMETRY_GLSL, /1\.0 - smoothstep\(0\.4, 1\.3, r\)/);
});

test("Julia loop stagnation returns smoothly to the base direction", () => {
  const root = juliaZero(),
    options = { mode: 3, base: 0.4, twist: 0.2 };
  assert.ok(angleDistance(geometryAngle(root, options), 0.4) < 1e-8);
  for (const offset of [-1e-7, 1e-7])
    assert.ok(
      angleDistance(geometryAngle([root[0] + offset, root[1]], options), 0.4) <
        1e-7,
    );
});

test("zero-flow dipole and vortex-pair stagnation points fall back continuously", () => {
  const root = Math.sqrt(0.45 ** 2 + 0.01 + 0.25 * 0.15);
  for (const [mode, x] of [
    [8, 0],
    [4, root],
    [4, -root],
  ])
    for (const offset of [-1e-7, 0, 1e-7]) {
      const theta = geometryAngle([x + offset, 0], { mode, base: 0.4 });
      assert.ok(Number.isFinite(theta));
      assert.ok(angleDistance(theta, 0.4) < 1e-7);
    }
});
