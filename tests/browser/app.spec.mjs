import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Make the suite independent of external font hosting.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
});

test("retained routes, model controls, and runtime loading are coherent", async ({
  page,
}) => {
  const errors = [];
  const runtimes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/vendor/")) runtimes.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#render-state")).not.toHaveText("BOOTING");
  await expect(page.locator(".nav__item")).toHaveCount(4);
  await expect(page.locator("#status-message")).toContainText("READY");
  expect(runtimes).toEqual([]);
  const names = await page.locator("#model-select option").allTextContents();
  expect(names.join(" ")).not.toMatch(/dog|neural dream|about/i);
  await page.locator("#model-select").selectOption("inception-dream");
  await expect(
    page.getByText("INFERENCE PIPELINE", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#parameter-controls select").first(),
  ).toContainText("Reduced Compute");
  await expect(page.locator("#save-gif")).toBeDisabled();
  await expect(page.locator(".modulation-toggle:visible")).toHaveCount(0);
  for (const view of ["archive", "experiments", "about", "lab"]) {
    await page.locator('[data-view="' + view + '"]').click();
    await expect(
      page.locator('[data-view-panel="' + view + '"]'),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("legacy navigation maps into the consolidated views", async ({ page }) => {
  for (const [hash, view] of [
    ["studio", "experiments"],
    ["datasets", "experiments"],
    ["method", "about"],
  ]) {
    await page.goto("/#" + hash);
    await expect(
      page.locator('[data-view-panel="' + view + '"]'),
    ).toBeVisible();
  }
});

test("navigation pauses the clock, saved runs restore, and PNG capture works", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("LIVE");
  await page.locator('[data-view="about"]').click();
  const pausedFrame = await page.locator("#frame-index").textContent();
  await page.waitForTimeout(250);
  expect(await page.locator("#frame-index").textContent()).toBe(pausedFrame);
  await page.locator('[data-view="lab"]').click();
  await expect
    .poll(() => page.locator("#frame-index").textContent())
    .not.toBe(pausedFrame);
  await page.locator("#run-experiment").click();
  await page.locator('[data-view="archive"]').click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".run-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: /restore|load/i })
    .first()
    .click();
  await expect(page.locator('[data-view-panel="lab"]')).toBeVisible();
  const download = page.waitForEvent("download");
  await page.locator("#save-image").click();
  await page.locator("#export-modal-confirm").click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});

for (const width of [360, 900, 1440]) {
  test("layout remains usable at width " + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator("#model-select")).toBeVisible();
    await expect(page.locator("#output-canvas")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.locator('[data-view="experiments"]').click();
    await expect(page.locator("#train-model")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  });
}

test("Quick PCA trains in its worker and renders the saved model", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/#experiments");
  await page.locator("#add-synthetic-set").click();
  await expect(page.locator("#add-synthetic-set")).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.locator("#sample-count")).toHaveText("32 / 64");
  await page.locator("#training-engine").selectOption("pca");
  await page.locator("#train-model").click();
  await expect(page.locator("#launch-custom")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#launch-custom").click();
  await expect(page.locator("#model-select")).toHaveValue("custom-pca");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await page.reload();
  await page.locator("#model-select").selectOption("custom-pca");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
});
