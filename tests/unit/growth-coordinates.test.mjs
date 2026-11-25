import test from "node:test";
import assert from "node:assert/strict";
import { getGridCoords } from "../../assets/js/app/growth-controller.js";

const rect = { left: 10, top: 20, width: 600, height: 400 };
const eventAt = (x, y) => ({ clientX: 110 + x * 400, clientY: 20 + y * 400 });

test("brush coordinates invert viewport zoom and pan in simulation space", () => {
  for (const zoom of [1, 2, 4, 8]) {
    for (const pan of [
      [0, 0],
      [0.2, -0.3],
      [-1.4, 1.8],
    ]) {
      const model = {
        simulationSize: 256,
        effectiveZoom: zoom,
        effectivePan: pan,
      };
      for (const [x, y] of [
        [0.13, 0.71],
        [0.5, 0.5],
        [0.91, 0.23],
      ]) {
        const coords = getGridCoords(eventAt(x, y), model, rect);
        // Project the result back through VISUALIZE, allowing whole torus turns.
        const expectedX = 0.5 + (x - 0.5) / zoom + pan[0];
        const expectedY = 0.5 + (0.5 - y) / zoom + pan[1];
        assert.ok(
          Math.abs(coords.nx - (expectedX - Math.floor(expectedX))) < 1e-12,
        );
        assert.ok(
          Math.abs(coords.ny - (expectedY - Math.floor(expectedY))) < 1e-12,
        );
        assert.equal(coords.gx, Math.floor(coords.nx * 256));
        assert.equal(coords.gy, Math.floor(coords.ny * 256));
      }
    }
  }
});

test("brush coordinates handle letterboxing, parameter zoom and wrapped edges", () => {
  const model = { simulationSize: 128, parameters: { zoom: 2 } };
  assert.deepEqual(getGridCoords(eventAt(0, 0.25), model, rect), {
    gx: 32,
    gy: 80,
    nx: 0.25,
    ny: 0.625,
  });
  assert.equal(getGridCoords(eventAt(-0.01, 0.5), model, rect), null);
  assert.equal(getGridCoords(eventAt(1, 0.5), model, rect), null);
  assert.equal(getGridCoords(eventAt(0.5, 1), model, rect), null);
  assert.equal(
    getGridCoords(eventAt(0.5, 0.5), model, { ...rect, height: 0 }),
    null,
  );
  model.effectivePan = [0.75, -0.75];
  assert.deepEqual(getGridCoords(eventAt(0.5, 0.5), model, rect), {
    gx: 32,
    gy: 96,
    nx: 0.25,
    ny: 0.75,
  });
  const tall = { left: 10, top: 20, width: 400, height: 600 };
  assert.equal(getGridCoords({ clientX: 210, clientY: 70 }, model, tall), null);
  assert.equal(
    getGridCoords({ clientX: 210, clientY: 320 }, model, tall).gx,
    32,
  );
});
