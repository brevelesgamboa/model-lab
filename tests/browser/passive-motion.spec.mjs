import { test, expect } from "@playwright/test";

test("passive transport matches spatial sampling across all twelve channels and packing seams", async ({
  page,
}) => {
  await page.goto("/runtime-check.html");
  const results = await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint } =
      await import("/assets/js/models/neural-growth/reference.js");
    const model = validateCheckpoint(
      await (
        await fetch(
          "/models/neural-growth/organic-structures/membrane-field.json",
        )
      ).json(),
    );
    const size = 32;
    const runtime = new TextureNcaRuntime({ model, size, seed: 17 });
    const initial = Uint8Array.from(
      { length: size * size * 12 },
      (_, i) => (i * 73 + Math.floor(i / 12) * 29) % 251,
    );
    const sample = (x, y, c) =>
      initial[
        ((((y % size) + size) % size) * size + (((x % size) + size) % size)) *
          12 +
          c
      ];
    const results = [];
    try {
      for (const field of ["wave", "vortex"]) {
        runtime.writeState(initial);
        const speed = 0.37,
          phase = 0.23;
        runtime.advect({ field, speed, phase });
        const state = runtime.readState();
        const changed = new Set();
        let error = 0;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const a = ((x + 0.5) * Math.PI * 2) / size + phase;
            const b = ((y + 0.5) * Math.PI * 2) / size + phase;
            const dx =
              field === "wave" ? Math.sin(b) : Math.sin(a) * Math.cos(b);
            const dy = field === "wave" ? 0 : -Math.cos(a) * Math.sin(b);
            const sx = x - speed * dx,
              sy = y - speed * dy;
            const left = Math.floor(sx),
              bottom = Math.floor(sy);
            const fx = sx - left,
              fy = sy - bottom;
            for (let c = 0; c < 12; c++) {
              const lower =
                sample(left, bottom, c) * (1 - fx) +
                sample(left + 1, bottom, c) * fx;
              const upper =
                sample(left, bottom + 1, c) * (1 - fx) +
                sample(left + 1, bottom + 1, c) * fx;
              const expected = Math.round(lower * (1 - fy) + upper * fy);
              const i = (y * size + x) * 12 + c;
              error = Math.max(error, Math.abs(state[i] - expected));
              if (state[i] !== initial[i]) changed.add(c);
            }
          }
        results.push({
          field,
          error,
          changed: changed.size,
          glError: runtime.gl.getError(),
          steps: runtime.steps,
        });
      }
      // At the wave's peak this row shifts by exactly one cell, including x=0.
      runtime.writeState(initial);
      runtime.advect({ field: "wave", speed: 1, phase: -Math.PI / size });
      const shifted = runtime.readState();
      const row = size / 4;
      let seamError = 0;
      for (let c = 0; c < 12; c++)
        seamError = Math.max(
          seamError,
          Math.abs(shifted[row * size * 12 + c] - sample(size - 1, row, c)),
        );
      return { results, seamError };
    } finally {
      runtime.dispose();
    }
  });
  for (const result of results.results) {
    expect(result.error).toBeLessThanOrEqual(1);
    expect(result.changed).toBe(12);
    expect(result.glError).toBe(0);
    expect(result.steps).toBe(0);
  }
  expect(results.seamError).toBeLessThanOrEqual(1);
});

test("zero flow is an exact no-op and experimental transport releases its resources", async ({
  page,
}) => {
  await page.goto("/runtime-check.html");
  const result = await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint } =
      await import("/assets/js/models/neural-growth/reference.js");
    const model = validateCheckpoint(
      await (
        await fetch("/models/neural-growth/organic-structures/xeno-reef.json")
      ).json(),
    );
    const runtime = new TextureNcaRuntime({ model, size: 32, seed: 17 });
    const initial = runtime.readState();
    const before = runtime.getStats().resources;
    runtime.advect({ speed: 0 });
    const stationary = runtime.readState();
    const unchanged = initial.every((value, i) => value === stationary[i]);
    const zeroResources = runtime.getStats().resources;
    let rejected = 0;
    for (const options of [
      { field: "unknown" },
      { speed: NaN },
      { speed: 2 },
      { phase: Infinity },
    ]) {
      try {
        runtime.advect(options);
      } catch (error) {
        if (error instanceof RangeError) rejected++;
      }
    }
    runtime.advect();
    const allocated = runtime.getStats().resources;
    for (let i = 0; i < 20; i++)
      runtime.advect({ field: "vortex", speed: 0.1 });
    const repeated = runtime.getStats().resources;
    runtime.restart(17);
    const restored = runtime.readState();
    const restartMatches = initial.every((value, i) => value === restored[i]);
    const glError = runtime.gl.getError();
    runtime.dispose();
    return {
      unchanged,
      before,
      zeroResources,
      allocated,
      repeated,
      rejected,
      restartMatches,
      glError,
      disposed: runtime.getStats().resources,
    };
  });
  expect(result.unchanged).toBe(true);
  expect(result.zeroResources).toEqual(result.before);
  expect(result.rejected).toBe(4);
  expect(result.allocated.programs).toBe(result.before.programs + 1);
  expect(result.repeated).toEqual(result.allocated);
  expect(result.restartMatches).toBe(true);
  expect(result.glError).toBe(0);
  expect(Object.values(result.disposed).every((value) => value === 0)).toBe(
    true,
  );
});
