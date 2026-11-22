import { test, expect } from "@playwright/test";

test("floating-point learned fields match differentiable transport across all state channels", async ({
  page,
}) => {
  await page.goto("/runtime-check.html");
  const result = await page.evaluate(async () => {
    const { activateTensorFlowBackend } =
      await import("/assets/js/training/tf-runtime.js");
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint } =
      await import("/assets/js/models/neural-growth/reference.js");
    const { limitMotionField } =
      await import("/assets/js/models/neural-growth/motion-field.js");
    const { warpWithMotion, upsampleMotionField, motionImage } =
      await import("/assets/js/models/neural-growth/inception-motion.js");
    const tf = await activateTensorFlowBackend(["webgl"]);
    const model = validateCheckpoint(
      await (
        await fetch(
          "/models/neural-growth/organic-structures/membrane-field.json",
        )
      ).json(),
    );
    const runtime = new TextureNcaRuntime({ model, size: 32, seed: 17 });
    const state = Uint8Array.from(
      { length: 32 * 32 * 12 },
      (_, i) => 60 + ((i * 37) % 130),
    );
    const velocity = limitMotionField(
      Float32Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.13) * 0.2),
    );
    runtime.writeState(state);
    const input = runtime.readPhenotypeRgb(32, 32);
    const warpedTensor = tf.tidy(() =>
      warpWithMotion(
        tf,
        motionImage(tf, input, 32, 32),
        tf.tensor4d(velocity, [1, 16, 16, 2]),
        { stateSize: 32, horizon: 1 },
      ),
    );
    const expected = await warpedTensor.data();
    warpedTensor.dispose();
    const denseTensor = tf.tidy(() =>
      upsampleMotionField(tf, tf.tensor4d(velocity, [1, 16, 16, 2]), 32, 32),
    );
    const dense = await denseTensor.data();
    denseTensor.dispose();
    runtime.setMotionField(velocity);
    runtime.advect({ field: "learned" });
    const actual = runtime.readState();
    let rgbError = 0,
      hiddenError = 0;
    const sample = (x, y, c) =>
      state[((((y % 32) + 32) % 32) * 32 + (((x % 32) + 32) % 32)) * 12 + c];
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const cell = y * 32 + x;
        const sx = x - dense[cell * 2],
          sy = y - dense[cell * 2 + 1];
        const lx = Math.floor(sx),
          ly = Math.floor(sy),
          fx = sx - lx,
          fy = sy - ly;
        for (let c = 0; c < 12; c++) {
          if (c < 3)
            rgbError = Math.max(
              rgbError,
              Math.abs(
                actual[cell * 12 + c] -
                  Math.round(((expected[cell * 3 + c] - 0.5) * 255) / 2 + 127),
              ),
            );
          else {
            const lower =
              sample(lx, ly, c) * (1 - fx) + sample(lx + 1, ly, c) * fx;
            const upper =
              sample(lx, ly + 1, c) * (1 - fx) + sample(lx + 1, ly + 1, c) * fx;
            hiddenError = Math.max(
              hiddenError,
              Math.abs(
                actual[cell * 12 + c] -
                  Math.round(lower * (1 - fy) + upper * fy),
              ),
            );
          }
        }
      }
    runtime.restart(17);
    const before = runtime.readState();
    runtime.advect({ field: "learned" });
    const after = runtime.readState();
    const cleared = before.every((value, i) => value === after[i]);
    const error = runtime.gl.getError();
    runtime.dispose();
    return { rgbError, hiddenError, cleared, error };
  });
  expect(result.rgbError).toBeLessThanOrEqual(1);
  expect(result.hiddenError).toBeLessThanOrEqual(1);
  expect(result.cleared).toBe(true);
  expect(result.error).toBe(0);
});
