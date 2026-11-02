import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEPTH_MODEL_ROOT } from "../../assets/js/models/depth-data.js";

test("real local MI-GAN produces a warp room and Depth Anything shapes the feathered frame", async ({
  page,
  context,
}, info) => {
  test.skip(
    !existsSync("models/inpainting/migan_pipeline_v2.onnx"),
    "Optional MI-GAN weights are not installed.",
  );
  test.setTimeout(240000);
  const depthDir = process.env.DOME_DEPTH_MODEL_DIR;
  if (depthDir)
    for (const name of ["model_q4.onnx", "model_q4.onnx_data"])
      await context.route(DEPTH_MODEL_ROOT + name, (route) =>
        route.fulfill({
          path: path.join(depthDir, name),
          headers: { "access-control-allow-origin": "*" },
        }),
      );
  await page.route("http://127.0.0.1:8080/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local warp inference</title>",
    }),
  );
  await page.goto("/");
  const result = await page.evaluate(async (withDepth) => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel();
    model.colorSwapRB = false;
    // Keep this optional integration test fully local without depth weights.
    if (!withDepth) {
      const factory = model.journeyFields.createFrontierWorkers;
      model.journeyFields.createFrontierWorkers = () => {
        const workers = factory();
        workers.depthEstimator = {
          dispose() {},
          estimate: async () => {
            throw Error("Local depth weights not supplied");
          },
        };
        return workers;
      };
    }
    const target = document.createElement("canvas");
    target.width = 160;
    target.height = 120;
    const params = Object.fromEntries(
      model.controls.map((c) => [c.key, c.default]),
    );
    try {
      model.newJourney(42);
      model.setJourneyEnabled(true);
      const started = performance.now();
      model.journey.startWarp("0,-1");
      const job = model.journeyFields.frontier;
      model.journey.advanceWarp(5);
      while (!job.result && !job.error) {
        if (performance.now() - started > 210000)
          throw Error(model.journeyFields.status);
        await new Promise((r) => setTimeout(r, 50));
      }
      if (job.error) throw Error(job.error);
      const room = model.journeyFields.pool.get("0,-1");
      model.journey.home();
      model.journey.startWarp("0,-1");
      model.journey.advanceWarp(5);
      await model.render(target, params, 10);
      const ctx = target.getContext("2d"),
        rgba = ctx.getImageData(0, 0, 160, 120).data;
      return {
        generator: room.generator,
        depthKind: room.depth.kind,
        depthWidth: room.depth.width,
        elapsed: performance.now() - started,
        gpuReady: room.gpu?.every((texture) => model.gl.isTexture(texture)),
        pixels: new Set(rgba).size,
        gl: model.gl.getError(),
        png: target.toDataURL(),
      };
    } finally {
      model.dispose();
    }
  }, Boolean(depthDir));
  expect(result.generator).toBe("MI-GAN");
  expect(result.depthKind).toBe(depthDir ? "estimated" : "luminance");
  expect(result.gpuReady).toBe(true);
  expect(result.pixels).toBeGreaterThan(20);
  expect(result.gl).toBe(0);
  await info.attach("local-warp-room", {
    body: Buffer.from(result.png.split(",")[1], "base64"),
    contentType: "image/png",
  });
  await writeFile(
    info.outputPath("local-warp-room.png"),
    Buffer.from(result.png.split(",")[1], "base64"),
  );
  delete result.png;
  console.log(JSON.stringify(result));
});
