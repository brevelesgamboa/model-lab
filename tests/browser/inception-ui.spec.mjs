import { test, expect } from "@playwright/test";

test("image upload, pipeline changes, pause, and completed ascent preserve canvas state", async ({
  page,
}) => {
  // Keep the real 320² graph/ascent path unmocked on software WebGL as well.
  test.setTimeout(500_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await page.locator("#model-select").selectOption("inception-dream");
  await page
    .getByRole("combobox", { name: "INFERENCE PIPELINE", exact: true })
    .selectOption("multi_octave_preview");
  await page
    .getByRole("combobox", { name: "OCTAVE LEVELS", exact: true })
    .selectOption("3");
  await page
    .getByRole("spinbutton", { name: "ASCENT STEPS PER OCTAVE exact value" })
    .fill("10");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    const data = context.createImageData(64, 64);
    for (let index = 0; index < data.data.length; index += 4) {
      const pixel = index / 4;
      data.data[index] = (pixel * 17) % 256;
      data.data[index + 1] = (pixel * 31) % 256;
      data.data[index + 2] = (pixel * 47) % 256;
      data.data[index + 3] = 255;
    }
    context.putImageData(data, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#neural-dream-image").setInputFiles({
    name: "source.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64"),
  });
  await expect(page.locator("#status-message")).toHaveText(
    "SOURCE IMAGE READY",
  );
  await page.locator("#load-neural-dream").click();
  await expect(page.locator("#load-neural-dream")).toHaveText("MODEL READY", {
    timeout: 240_000,
  });
  const source = await page
    .locator("#output-canvas")
    .evaluate((canvas) => canvas.toDataURL());
  await page.locator('[data-dream-mode="dream"]').click();
  await expect(page.locator("#neural-dream-status")).toContainText("OCTAVE", {
    timeout: 30_000,
  });
  await page.locator('[data-view="about"]').click();
  await page.waitForTimeout(300);
  const paused = await page
    .locator("#output-canvas")
    .evaluate((canvas) => canvas.toDataURL());
  await page.waitForTimeout(300);
  expect(
    await page
      .locator("#output-canvas")
      .evaluate((canvas) => canvas.toDataURL()),
  ).toBe(paused);
  await page.locator('[data-view="lab"]').click();
  await expect(page.locator("#neural-dream-status")).toContainText("COMPLETE", {
    timeout: 380_000,
  });
  const completed = await page
    .locator("#output-canvas")
    .evaluate((canvas) => canvas.toDataURL());
  expect(completed).not.toBe(source);
  await page.locator("#toggle-animation").click();
  await page
    .getByRole("combobox", { name: "INFERENCE PIPELINE", exact: true })
    .selectOption("multi_octave_quality");
  await page.waitForTimeout(200);
  expect(
    await page.locator("#output-canvas").evaluate((canvas) => {
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let index = 0; index < data.length; index += 4)
        sum += data[index] + data[index + 1] + data[index + 2];
      return sum > 0;
    }),
  ).toBe(true);
  expect(errors).toEqual([]);
});
