import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("experimental texture reprojection matches a translated dome view and preserves stationary pixels", async ({
  page,
}) => {
  const source = await readFile(
    new URL("../../tools/dream-drift-projection.mjs", import.meta.url),
    "utf8",
  );
  await page.route("**/projection-experiment.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.route("http://127.0.0.1:8080/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Projection calibration</title>",
    }),
  );
  await page.goto("/");
  const measurements = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const { advancePanoramaPixels } = await import("/projection-experiment.js");
    const width = 512,
      height = 256,
      data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
        const ring = Math.cos(latitude);
        data.set(
          [
            128 +
              60 * Math.sin(longitude) * ring +
              20 * Math.sin(4 * longitude) * ring,
            128 + 60 * Math.sin(latitude),
            128 - 60 * Math.cos(longitude) * ring,
            255,
          ],
          (y * width + x) * 4,
        );
      }
    const canvas = (bytes) => {
      const result = new OffscreenCanvas(width, height);
      result
        .getContext("2d")
        .putImageData(new ImageData(bytes, width, height), 0, 0);
      return result;
    };
    const original = canvas(data),
      model = new CorticalDreamDomeModel();
    const target = document.createElement("canvas");
    target.width = 384;
    target.height = 256;
    const parameters = Object.fromEntries(
      model.controls.map((control) => [control.key, control.default]),
    );
    Object.assign(parameters, {
      gain: 0,
      edgeCoupling: 0,
      chromaticDispersion: 0,
      depthScale: 0,
      neuralSwell: 0,
      cameraDolly: 0,
    });
    await model.ensureGraphics();
    async function render(panorama, yaw, pitch, offset) {
      model.panorama = panorama;
      model.outpaintingMode = "migan";
      model.photoRect = { x: 0, y: 0, width, height, feather: 1 };
      model.camera.reset();
      model.camera.yaw = yaw;
      model.camera.pitch = pitch;
      model.camera.target = [0, 0, -offset];
      model.uploadSource();
      await model.render(target, parameters, 0);
      return target
        .getContext("2d")
        .getImageData(0, 0, target.width, target.height).data;
    }
    const rows = [];
    try {
      for (const advance of [0, 0.08]) {
        const warped = canvas(
          advancePanoramaPixels(data, width, height, advance),
        );
        for (const [yaw, pitch] of [
          [0, 0],
          [0.5, 0],
          [-0.3, 0.25],
        ]) {
          // The experimental flat sphere has radius 5. This reference moves
          // its actual observer by the equivalent amount in a fixed direction.
          const reference = await render(original, yaw, pitch, advance * 5);
          const actual = await render(warped, yaw, pitch, 0);
          let sum = 0,
            max = 0;
          for (let i = 0; i < actual.length; i += 4)
            for (let channel = 0; channel < 3; channel++) {
              const delta = Math.abs(
                actual[i + channel] - reference[i + channel],
              );
              sum += delta;
              max = Math.max(max, delta);
            }
          rows.push({
            advance,
            yaw,
            pitch,
            meanAbsoluteRgbByte: sum / ((actual.length / 4) * 3),
            maxAbsoluteRgbByte: max,
          });
        }
      }
      return {
        rows,
        glError: model.gl.getError(),
        depthRuns: model.estimator.runs,
        featureRuns: model.featureEstimator.runs,
      };
    } finally {
      model.dispose();
    }
  });
  expect(measurements.glError).toBe(0);
  expect(measurements.depthRuns).toBe(0);
  expect(measurements.featureRuns).toBe(0);
  for (const row of measurements.rows) {
    if (row.advance === 0) expect(row.maxAbsoluteRgbByte).toBe(0);
    else expect(row.meanAbsoluteRgbByte).toBeLessThan(1);
  }
  console.log(JSON.stringify(measurements));
});
