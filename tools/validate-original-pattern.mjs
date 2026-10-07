import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { createTrainingServer } from "./train-neural-growth.mjs";

const checkpoint = JSON.parse(await readFile(process.argv[2], "utf8"));
const output = path.resolve(
  process.argv[3] || "/tmp/latent-field-original-validation",
);
await mkdir(output, { recursive: true });
const server = createTrainingServer(checkpoint.id);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
});
try {
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.address().port}/?pattern=${checkpoint.id}&spatial=${process.argv[4] === "spatial" ? 1 : 0}`,
  );
  await page.waitForFunction(() => Boolean(window.patternTrainer));
  const parity = await page.evaluate(async (raw) => {
    const tf = window.tf;
    const trainer = window.patternTrainer.trainer;
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint, referenceStep } =
      await import("/assets/js/models/neural-growth/reference.js");
    const model = validateCheckpoint(raw);
    for (let index = 0; index < 2; index += 1) {
      const tensor = tf.tensor2d(
        model.layers[index].coefficients,
        model.layers[index].shape,
      );
      trainer.variables[index].assign(tensor);
      tensor.dispose();
    }
    const size = 32;
    const runtime = new TextureNcaRuntime({ model, size, seed: 73 });
    try {
      const initial = Uint8Array.from(
        { length: size * size * 12 },
        (_, index) => 112 + ((index * 13) % 31),
      );
      runtime.writeState(initial);
      runtime.step();
      const actual = runtime.readState();
      const mask = runtime.getLastUpdateMask();
      const oracle = referenceStep(initial, model, size, mask);
      const trained = tf.tidy(() =>
        trainer.step(
          tf.tensor4d(
            Float32Array.from(initial, (value) => ((value - 127) * 4) / 255),
            [1, size, size, 12],
          ),
          tf.tensor4d(Float32Array.from(mask), [1, size, size, 1]),
        ),
      );
      const values = await trained.data();
      trained.dispose();
      let trainingMaxError = 0;
      let runtimeMaxError = 0;
      for (let index = 0; index < actual.length; index += 1) {
        const byte = Math.max(
          0,
          Math.min(255, Math.floor((values[index] * 255) / 4 + 127.5)),
        );
        trainingMaxError = Math.max(
          trainingMaxError,
          Math.abs(byte - actual[index]),
        );
        runtimeMaxError = Math.max(
          runtimeMaxError,
          Math.abs(oracle[index] - actual[index]),
        );
      }
      return {
        trainingMaxError,
        runtimeMaxError,
        renderer: runtime.getStats().renderer,
      };
    } finally {
      runtime.dispose();
    }
  }, checkpoint);
  assert.ok(
    parity.trainingMaxError <= 1,
    "Training/inference parity exceeds one byte.",
  );
  assert.ok(
    parity.runtimeMaxError <= 1,
    "GPU/reference parity exceeds one byte.",
  );
  const results = [];
  for (const size of [128, 256])
    for (const seed of [1, 17, 42]) {
      await page.evaluate(
        async ({ raw, size, seed }) => {
          const { TextureNcaRuntime } =
            await import("/assets/js/models/neural-growth/runtime.js");
          const { validateCheckpoint } =
            await import("/assets/js/models/neural-growth/reference.js");
          window.validationRuntime = new TextureNcaRuntime({
            model: validateCheckpoint(raw),
            size,
            seed,
          });
        },
        { raw: checkpoint, size, seed },
      );
      for (const steps of [64, 256, 512, 2048, 8192]) {
        const result = await page.evaluate(async (steps) => {
          const runtime = window.validationRuntime;
          let remaining = steps - runtime.getStats().steps;
          while (remaining > 0) {
            const count = Math.min(128, remaining);
            runtime.step(count);
            remaining -= count;
          }
          const state = runtime.readState();
          const rgb = Array.from({ length: 3 }, () => ({
            mean: 0,
            second: 0,
            saturated: 0,
          }));
          const cells = runtime.size ** 2;
          for (let cell = 0; cell < cells; cell += 1)
            for (let channel = 0; channel < 3; channel += 1) {
              const value = Math.max(
                0,
                Math.min(
                  1,
                  ((state[cell * 12 + channel] - 127) * 2) / 255 + 0.5,
                ),
              );
              rgb[channel].mean += value / cells;
              rgb[channel].second += value ** 2 / cells;
              rgb[channel].saturated +=
                value === 0 || value === 1 ? 1 / cells : 0;
            }
          const tensor = window.tf.tensor4d(
            Float32Array.from(state, (value) => ((value - 127) * 4) / 255),
            [1, runtime.size, runtime.size, 12],
          );
          const loss = window.tf.tidy(() =>
            window.patternTrainer.trainer.lossFor(tensor),
          );
          const lossValue = (await loss.data())[0];
          tensor.dispose();
          loss.dispose();
          runtime.draw(document.querySelector("#preview"));
          return { ...runtime.getStats(), rgb, loss: lossValue };
        }, steps);
        results.push(result);
        assert.ok(Number.isFinite(result.loss), "Non-finite validation loss.");
        if (steps >= 512)
          assert.ok(
            result.rgb.some(({ mean, second }) => second - mean ** 2 > 0.005),
            "Pattern collapsed to a flat field.",
          );
        await page.locator("#preview").screenshot({
          path: path.join(output, `${size}-${seed}-${steps}.png`),
        });
        console.log(
          JSON.stringify({
            size,
            seed,
            steps,
            loss: result.loss,
            rgb: result.rgb,
          }),
        );
      }
      const recovery = await page.evaluate(() => {
        const runtime = window.validationRuntime;
        const resources = runtime.getStats().resources;
        runtime.disturb(
          runtime.size / 2,
          runtime.size / 2,
          runtime.size * 0.15,
        );
        for (let index = 0; index < 16; index += 1) runtime.step(128);
        const stats = runtime.getStats();
        runtime.draw(document.querySelector("#preview"));
        runtime.dispose();
        return {
          size: stats.size,
          seed: stats.seed,
          before: resources,
          after: stats.resources,
          disposed: runtime.getStats().resources,
        };
      });
      results.push({ recovery });
      assert.deepEqual(
        recovery.before,
        recovery.after,
        "Runtime allocation counts changed during recovery.",
      );
      assert.ok(
        Object.values(recovery.disposed).every((value) => value === 0),
        "Runtime resources were not released.",
      );
      await page.locator("#preview").screenshot({
        path: path.join(output, `${size}-${seed}-recovery.png`),
      });
    }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checkpoint: checkpoint.id, parity, results }, null, 2) +
      "\n",
  );
  console.log(JSON.stringify(parity));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
