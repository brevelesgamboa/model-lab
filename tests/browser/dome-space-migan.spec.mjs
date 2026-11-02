import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEPTH_MODEL_ROOT } from "../../assets/js/models/depth-data.js";

test("real MI-GAN extends four regions, protects known image pixels and optionally estimates their real depth", async ({
  page,
  context,
}, info) => {
  test.skip(
    !existsSync("models/inpainting/migan_pipeline_v2.onnx"),
    "Optional MI-GAN weights are not installed.",
  );
  test.setTimeout(240000);
  const dir = process.env.DOME_DEPTH_MODEL_DIR;
  if (dir)
    for (const file of ["model_q4.onnx", "model_q4.onnx_data"])
      await context.route(DEPTH_MODEL_ROOT + file, (r) =>
        r.fulfill({
          path: path.join(dir, file),
          headers: { "access-control-allow-origin": "*" },
        }),
      );
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Real regional inpainting</title>",
    }),
  );
  await page.goto("/");
  const result = await page.evaluate(async (withDepth) => {
    const { DomeJourneyFields, prepareDreamRegion } =
      await import("/assets/js/models/dome-journey-fields.js");
    const { MiganInpainter } =
      await import("/assets/js/models/migan-inpainter.js");
    const { DepthEstimator } =
      await import("/assets/js/models/depth-estimator.js");
    const { DREAM_REGIONS } = await import("/assets/js/models/dome-journey.js");
    const source = new OffscreenCanvas(512, 256),
      ctx = source.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#a5c9de");
    g.addColorStop(0.6, "#d9d7bd");
    g.addColorStop(1, "#3c7057");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = "#677d63";
    ctx.beginPath();
    ctx.moveTo(0, 180);
    ctx.lineTo(130, 70);
    ctx.lineTo(240, 180);
    ctx.lineTo(350, 110);
    ctx.lineTo(512, 180);
    ctx.lineTo(512, 256);
    ctx.lineTo(0, 256);
    ctx.fill();
    ctx.fillStyle = "#cfb48c";
    ctx.fillRect(190, 145, 100, 75);
    ctx.fillStyle = "#4f5c68";
    ctx.fillRect(225, 175, 25, 45);
    const before = ctx.getImageData(0, 0, 512, 256).data,
      inpainter = new MiganInpainter();
    const fields = new DomeJourneyFields({
      inpainter,
      depthEstimator: withDepth ? new DepthEstimator() : null,
    });
    const started = performance.now();
    try {
      const ready = await fields.generate(source, "mixed_6a", 42);
      let sourceError = 0,
        knownError = 0,
        fillChange = 0,
        n = 0;
      const after = ctx.getImageData(0, 0, 512, 256).data;
      for (let i = 0; i < before.length; i++)
        sourceError = Math.max(sourceError, Math.abs(before[i] - after[i]));
      for (const [index, image] of fields.images.entries()) {
        const seed = prepareDreamRegion(source, DREAM_REGIONS[index + 1]);
        const a = seed.canvas
            .getContext("2d")
            .getImageData(0, 0, 512, 256).data,
          b = image.getContext("2d").getImageData(0, 0, 512, 256).data;
        for (let i = 0; i < seed.known.length; i++)
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
            if (seed.known[i]) knownError = Math.max(knownError, d);
            else {
              fillChange += d;
              n++;
            }
          }
      }
      const images = [];
      for (const c of [source, ...fields.images]) {
        const blob = await c.convertToBlob({ type: "image/png" });
        images.push(
          await new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(",")[1]);
            r.readAsDataURL(blob);
          }),
        );
      }
      return {
        ready,
        state: fields.state,
        status: fields.status,
        sourceError,
        knownError,
        fillChange: fillChange / n,
        metrics: fields.metrics,
        depths: fields.depthMaps.map(
          ({ width, height, kind, backend, inferenceMs }) => ({
            width,
            height,
            kind,
            backend,
            inferenceMs,
          }),
        ),
        workerReleased: inpainter.worker === null,
        totalMs: performance.now() - started,
        images,
      };
    } finally {
      fields.cancel();
    }
  }, Boolean(dir));
  expect(result.ready, result.status).toBe(true);
  expect(result.sourceError).toBe(0);
  expect(result.knownError).toBe(0);
  expect(result.fillChange).toBeGreaterThan(0.1);
  expect(result.metrics.length).toBe(4);
  expect(result.workerReleased).toBe(true);
  expect(
    result.metrics.every(
      (m) => m.knownFraction === 0.875 && m.refinement === null,
    ),
  ).toBe(true);
  if (dir) {
    expect(result.depths.length).toBe(4);
    expect(result.depths.every((d) => d.kind === "estimated")).toBe(true);
  }
  for (const [i, png] of result.images.entries())
    await writeFile(
      info.outputPath(`regional-${i}.png`),
      Buffer.from(png, "base64"),
    );
  delete result.images;
  await writeFile(
    info.outputPath("measurements.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
});
