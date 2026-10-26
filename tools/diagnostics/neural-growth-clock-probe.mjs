import { mkdir, readFile, writeFile } from "node:fs/promises";
import { NeuralGrowthModel } from "../../assets/js/models/neural-growth.js";
import { defaultParameters } from "../../assets/js/core/model-contract.js";
const checkpoint = JSON.parse(
  await readFile(
    new URL("../../models/neural-growth/checkpoint.json", import.meta.url),
    "utf8",
  ),
);
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ width: 0, height: 0 }) };
const results = [];
try {
  for (const fps of [60, 30, 20, 15, 10, 5]) {
    let runtime;
    const model = new NeuralGrowthModel({
      capabilities: { maxTextureSize: 16384 },
      load: async () => checkpoint,
      createRuntime: ({ size, seed }) =>
        (runtime = {
          size,
          seed,
          steps: 0,
          disposed: false,
          step(count) {
            this.steps += count;
          },
          draw() {},
          restart(next) {
            this.seed = next;
            this.steps = 0;
          },
          dispose() {
            this.disposed = true;
          },
          getStats() {
            return {
              size: this.size,
              seed: this.seed,
              steps: this.steps,
              resources: { bytes: 0 },
            };
          },
        }),
    });
    const parameters = {
      ...defaultParameters(model),
      growthSpeed: 30,
      dreamEnabled: "off",
      dreamStrength: 0,
    };
    const canvas = { width: 768, height: 768 };
    await model.render(canvas, parameters, 0);
    model.setClockRunning(true);
    await model.render(canvas, parameters, 0, { advanceSimulation: true });
    const duration = 10;
    for (let i = 1; i <= fps * duration; i++)
      await model.render(canvas, parameters, i / fps, {
        advanceSimulation: true,
      });
    results.push({
      renderFps: fps,
      requestedStepsPerSecond: 30,
      durationSeconds: duration,
      actualSteps: runtime.steps,
      actualStepsPerSecond: runtime.steps / duration,
    });
    model.dispose();
  }
} finally {
  globalThis.document = previousDocument;
}
await mkdir(
  new URL("../../diagnostics/neural-growth-performance/", import.meta.url),
  { recursive: true },
);
await writeFile(
  new URL(
    "../../diagnostics/neural-growth-performance/clock-results.json",
    import.meta.url,
  ),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
