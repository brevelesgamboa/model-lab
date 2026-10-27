import { test, expect } from "@playwright/test";

async function imageFiles(page) {
  const urls = await page.evaluate(() =>
    ["#e87060", "#47a8d8", "#70b978"].map((color, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 128, 128);
      context.fillStyle = "#fff";
      context.fillRect(12 + index * 25, 15, 20, 90);
      return canvas.toDataURL("image/png");
    }),
  );
  return urls.map((url, index) => ({
    name: `sample-${index}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(url.split(",")[1], "base64"),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
});

test("Saved Runs supports real previews, model filters, restore, export and deletion", async ({
  page,
}) => {
  await page.locator('[data-parameter="scale"] .fine-input').fill("2.4");
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  await page.locator("#model-select").selectOption("chromatic-field");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await page.locator("#run-experiment").click();
  await expect(page.locator("#archive-runs")).toHaveText("2");
  await page.locator('[data-view="saved"]').click();
  await expect(page.locator(".run-card")).toHaveCount(2);
  await expect(page.locator(".run-card").first()).toBeVisible();
  const preview = page.locator(".run-card__image").first();
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate(async (image) => {
      await image.decode();
      return image.naturalWidth;
    }),
  ).toBeGreaterThan(0);
  await page.locator("#archive-model-filter").selectOption("folded-fractal");
  await expect(page.locator(".run-card")).toHaveCount(1);
  await expect(page.locator(".run-card h3")).toHaveText("Folded Fractal");
  const download = page.waitForEvent("download");
  await page.locator("#export-csv").click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page
    .locator(".run-card")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(page.locator("#view-lab")).toBeVisible();
  await expect(page.locator("#model-select")).toHaveValue("folded-fractal");
  await expect(
    page.locator('[data-parameter="scale"] .fine-input'),
  ).toHaveValue("2.4");
  await page.locator('[data-view="saved"]').click();
  await page.reload();
  await expect(page.locator(".run-card")).toHaveCount(2);
  await page
    .locator(".run-card")
    .first()
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#clear-archive").click();
  await expect(page.locator(".archive-empty")).toContainText(
    "No saved runs yet",
  );
  await expect(page.locator("#export-csv")).toBeDisabled();
  await page
    .locator(".archive-empty")
    .getByRole("button", { name: "Open Lab" })
    .click();
  await expect(page.locator("#view-lab")).toBeVisible();
});

test("Experiments uploads, trains Quick PCA in its worker, persists and opens the model", async ({
  page,
}) => {
  await page.locator('[data-view="experiments"]').click();
  await expect(page.locator("#train-model")).toBeVisible();
  await expect(page.locator("#train-model")).toBeDisabled();
  await page.locator("#image-upload").setInputFiles(await imageFiles(page));
  await expect(page.locator("#sample-count")).toHaveText("3 / 64");
  await expect(page.locator("#train-model")).toBeEnabled();
  await page.locator("#custom-model-name").fill("Three colors");
  await page.locator("#train-model").click();
  await expect(page.locator("#custom-status")).toHaveText("Ready");
  await expect(page.locator("#custom-samples")).toHaveText("3");
  await expect(page.locator("#launch-custom")).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.locator("#export-model").click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await page.locator("#launch-custom").click();
  await expect(page.locator("#view-lab")).toBeVisible();
  await expect(page.locator("#model-select")).toHaveValue("custom-pca");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await page.reload();
  await page.locator('[data-view="experiments"]').click();
  await expect(page.locator("#custom-status")).toHaveText("Ready");
  await expect(page.locator("#custom-id")).toHaveText("Three colors");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-model").click();
  await expect(page.locator("#custom-status")).toHaveText("Not trained");
  await expect(page.locator("#launch-custom")).toBeDisabled();
});

test("drawing and image search controls are usable inside Experiments", async ({
  page,
}) => {
  await page.locator('[data-view="experiments"]').click();
  const canvas = page.locator("#draw-canvas");
  const bounds = await canvas.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height * 0.2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.8,
    bounds.y + bounds.height * 0.8,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.locator("#add-drawing").click();
  await expect(page.locator("#sample-count")).toHaveText("1 / 64");
  await page.locator("#sample-grid button").click();
  await expect(page.locator("#sample-count")).toHaveText("0 / 64");
  await page.locator("#clear-drawing").click();
  await page.locator("#open-datasets-from-studio").click();
  await expect(page.locator("#dataset-library")).toHaveAttribute("open", "");
  await expect(page.locator("#commons-search-input")).toBeVisible();
  await page.route("https://commons.wikimedia.org/w/api.php?*", (route) =>
    route.fulfill({
      json: {
        query: {
          pages: [
            {
              pageid: 1,
              title: "File:Test image",
              imageinfo: [
                {
                  mime: "image/png",
                  url: "https://example.test/image.png",
                  thumburl: "https://example.test/image.png",
                  descriptionurl: "https://example.test/source",
                  width: 128,
                  height: 128,
                  extmetadata: {
                    LicenseShortName: { value: "CC0" },
                    Artist: { value: "Test author" },
                  },
                },
              ],
            },
          ],
        },
      },
    }),
  );
  const [file] = await imageFiles(page);
  await page.route("https://example.test/image.png", (route) =>
    route.fulfill({ contentType: "image/png", body: file.buffer }),
  );
  await page.locator("#commons-search-button").click();
  await expect(page.locator(".commons-card")).toHaveCount(1);
  await expect(page.locator(".commons-card")).toContainText("CC0");
  await page
    .locator(".commons-card")
    .getByRole("button", { name: "Add image" })
    .click();
  await expect(page.locator("#sample-count")).toHaveText("1 / 64");
});

test("neural training retains its hardware check", async ({ page }) => {
  await page.locator('[data-view="experiments"]').click();
  await page.locator("#training-engine").selectOption("neural");
  await expect(page.locator("#neural-training-controls")).toBeVisible();
  await expect(page.locator("#train-model")).toBeDisabled();
  await page.evaluate(async () => {
    const { TrainingManager } =
      await import("/assets/js/training/training-manager.js");
    TrainingManager.prototype.benchmark = async () => ({
      accelerated: true,
      backend: "webgl",
      speedClass: "FAST",
      millisecondsPerPass: 2,
      recommendedQuality: "high",
    });
  });
  await page.locator("#benchmark-training").click();
  await expect(page.locator("#training-status")).toContainText(
    "Neural training access enabled",
  );
  await expect(page.locator("#train-model")).toBeDisabled();
  await page.locator("#training-engine").selectOption("pca");
  await expect(page.locator("#pca-training-controls")).toBeVisible();
});

test("About has useful model cards and working Lab links", async ({ page }) => {
  await page.locator('[data-view="about"]').click();
  await expect(page.locator(".about-card")).toHaveCount(8);
  await expect(
    page.locator(
      "#view-about code, #view-about .panel-code, #view-about .eyebrow",
    ),
  ).toHaveCount(0);
  for (const id of ["chromatic-field", "folded-fractal", "fractal-functions"]) {
    await page.locator(`[data-open-model="${id}"]`).click();
    await expect(page.locator("#view-lab")).toBeVisible();
    await expect(page.locator("#model-select")).toHaveValue(id);
    await page.locator('[data-view="about"]').click();
  }
  await page
    .locator(".about-card")
    .getByRole("link", { name: "Open Experiments" })
    .click();
  await expect(page.locator("#view-experiments")).toBeVisible();
});

for (const width of [360, 900, 1440]) {
  test(`restored views fit and scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["saved", "experiments", "about"]) {
      await page.locator(`[data-view="${view}"]`).click();
      const panel = page.locator(`#view-${view}`);
      await expect(panel).toBeVisible();
      const fits = await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      );
      expect(fits).toBe(true);
      await expect(page.locator(`[data-view="${view}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });
}

test("tab links keep early clicks while the app is loading", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/js/app.js", async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload();
  await page.locator('[data-view="experiments"]').click();
  await expect(page).toHaveURL(/#experiments$/);
  release();
  await expect(page.locator("#view-experiments")).toBeVisible();
  await expect(page.locator("#train-model")).toBeVisible();
});
